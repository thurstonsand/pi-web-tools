export interface BrowserContextHandle {
  close(): Promise<void>;
  on(event: "close", listener: () => void): void;
}

export interface BrowserLauncher<Context extends BrowserContextHandle> {
  launch(headless: boolean, userAgent?: string): Promise<Context>;
  probeUserAgent(context: Context): Promise<string | null>;
}

export interface BrowserSessionOptions<Context extends BrowserContextHandle> {
  launcher: BrowserLauncher<Context>;
  maxConcurrentPages: number;
  interactiveConflictMessage: string;
  headlessLaunchError(error: unknown): Error;
  headedLaunchError(error: unknown): Error;
  interactiveLaunchError(error: unknown): Error;
  onInteractiveStateChange?(open: boolean): void;
}

export interface BrowserFetch<Context extends BrowserContextHandle, Result> {
  headless(context: Context): Promise<Result>;
  headed(context: Context): Promise<Result>;
  shouldEscalate(error: unknown): boolean;
  onStarted(): void;
}

export class BrowserSession<Context extends BrowserContextHandle> {
  private readonly options: BrowserSessionOptions<Context>;
  private contextPromise: Promise<Context> | null = null;
  private interactiveContext: Context | null = null;
  private interactiveOpen = false;
  private availableSlots: number;
  private readonly slotWaiters: Array<() => void> = [];
  private escalation: Promise<void> | null = null;
  private activeHeadlessFetches = 0;
  private readonly drainWaiters: Array<() => void> = [];
  private headlessUserAgent: { probed: boolean; userAgent: string | undefined } = {
    probed: false,
    userAgent: undefined,
  };

  constructor(options: BrowserSessionOptions<Context>) {
    this.options = options;
    this.availableSlots = options.maxConcurrentPages;
  }

  get isInteractiveOpen(): boolean {
    return this.interactiveOpen;
  }

  async fetch<Result>(operation: BrowserFetch<Context, Result>): Promise<Result> {
    try {
      return await this.headlessFetch(operation);
    } catch (error) {
      if (operation.shouldEscalate(error)) return this.escalatedFetch(operation);
      throw error;
    }
  }

  async openInteractive(): Promise<void> {
    if (this.interactiveOpen) {
      throw new Error("interactive browser is already open");
    }
    const headless = this.contextPromise ? await this.contextPromise.catch(() => null) : null;
    this.contextPromise = null;
    await headless?.close().catch(() => {});

    this.setInteractiveOpen(true);
    try {
      const context = await this.options.launcher.launch(false);
      this.interactiveContext = context;
      context.on("close", () => {
        if (this.interactiveContext !== context) return;
        this.interactiveContext = null;
        this.setInteractiveOpen(false);
      });
    } catch (error) {
      this.setInteractiveOpen(false);
      throw this.options.interactiveLaunchError(error);
    }
  }

  async close(): Promise<void> {
    const headless = this.contextPromise ? await this.contextPromise.catch(() => null) : null;
    this.contextPromise = null;
    await headless?.close().catch(() => {});
    const interactive = this.interactiveContext;
    await interactive?.close().catch(() => {});
    if (this.interactiveContext === interactive) {
      this.interactiveContext = null;
      if (this.interactiveOpen) this.setInteractiveOpen(false);
    }
  }

  private async headlessFetch<Result>(operation: BrowserFetch<Context, Result>): Promise<Result> {
    while (this.escalation) await this.escalation;
    // Count requests admitted through the gate, including slot waiters, so an
    // escalation cannot close their shared context before they run.
    this.activeHeadlessFetches += 1;
    try {
      this.assertNotInteractive();
      const context = await this.getContext();
      return await this.withPageSlot(async () => {
        operation.onStarted();
        return operation.headless(context);
      });
    } finally {
      this.activeHeadlessFetches -= 1;
      if (this.activeHeadlessFetches === 0) {
        for (const wake of this.drainWaiters.splice(0)) wake();
      }
    }
  }

  private async escalatedFetch<Result>(operation: BrowserFetch<Context, Result>): Promise<Result> {
    // Escalation recovers the shared profile. A request that waited behind one
    // retries headless before deciding it still needs another visible window.
    while (this.escalation) {
      await this.escalation;
      try {
        return await this.headlessFetch({ ...operation, onStarted: () => {} });
      } catch (error) {
        if (!operation.shouldEscalate(error)) throw error;
      }
    }

    let release!: () => void;
    this.escalation = new Promise((resolve) => {
      release = resolve;
    });
    try {
      while (this.activeHeadlessFetches > 0) {
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      }
      this.assertNotInteractive();
      const headless = this.contextPromise ? await this.contextPromise.catch(() => null) : null;
      this.contextPromise = null;
      await headless?.close().catch(() => {});

      let headed: Context;
      try {
        headed = await this.options.launcher.launch(false);
      } catch (error) {
        throw this.options.headedLaunchError(error);
      }
      try {
        return await operation.headed(headed);
      } finally {
        await headed.close().catch(() => {});
      }
    } finally {
      this.escalation = null;
      release();
    }
  }

  private async getContext(): Promise<Context> {
    this.contextPromise ??= this.launchContext();
    try {
      return await this.contextPromise;
    } catch (error) {
      this.contextPromise = null;
      throw error;
    }
  }

  private async launchContext(): Promise<Context> {
    try {
      const context = await this.launchHeadlessWithNormalUserAgent();
      context.on("close", () => {
        this.contextPromise = null;
      });
      return context;
    } catch (error) {
      throw this.options.headlessLaunchError(error);
    }
  }

  private async launchHeadlessWithNormalUserAgent(): Promise<Context> {
    // A failed probe keeps the original context and retries after its next
    // launch; a successful probe is cached even when no override is needed.
    if (this.headlessUserAgent.probed) {
      return this.options.launcher.launch(true, this.headlessUserAgent.userAgent);
    }
    const probe = await this.options.launcher.launch(true);
    const userAgent = await this.options.launcher.probeUserAgent(probe);
    if (userAgent === null) return probe;
    if (!userAgent.includes("HeadlessChrome")) {
      this.headlessUserAgent = { probed: true, userAgent: undefined };
      return probe;
    }
    await probe.close().catch(() => {});
    this.headlessUserAgent = {
      probed: true,
      userAgent: userAgent.replace("HeadlessChrome", "Chrome"),
    };
    return this.options.launcher.launch(true, this.headlessUserAgent.userAgent);
  }

  private async withPageSlot<Result>(work: () => Promise<Result>): Promise<Result> {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
    } else {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = this.slotWaiters.shift();
      if (next) next();
      else this.availableSlots += 1;
    }
  }

  private assertNotInteractive(): void {
    if (this.interactiveOpen) throw new Error(this.options.interactiveConflictMessage);
  }

  private setInteractiveOpen(open: boolean): void {
    this.interactiveOpen = open;
    this.options.onInteractiveStateChange?.(open);
  }
}
