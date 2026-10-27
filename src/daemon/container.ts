import type { ILogger, DaemonConfig } from "./types.js";

export type ServiceLifetime = "singleton" | "transient";

export interface ServiceToken<T> {
  readonly description: string;
  readonly _type?: T;
}

export function createToken<T>(description: string): ServiceToken<T> {
  return { description };
}

export interface IContainer {
  register<T>(token: ServiceToken<T>, factory: (c: IContainer) => T, lifetime?: ServiceLifetime): this;
  registerInstance<T>(token: ServiceToken<T>, instance: T): this;
  resolve<T>(token: ServiceToken<T>): T;
  has<T>(token: ServiceToken<T>): boolean;
  createChild(): IContainer;
}

interface ServiceBinding<T> {
  factory: (c: IContainer) => T;
  lifetime: ServiceLifetime;
  cachedInstance?: T;
}

export class ServiceContainer implements IContainer {
  private bindings = new Map<ServiceToken<unknown>, ServiceBinding<unknown>>();
  private parent?: IContainer | undefined;

  constructor(parent?: IContainer | undefined) {
    this.parent = parent;
  }

  register<T>(
    token: ServiceToken<T>,
    factory: (c: IContainer) => T,
    lifetime: ServiceLifetime = "singleton"
  ): this {
    this.bindings.set(token as ServiceToken<unknown>, {
      factory: factory as (c: IContainer) => unknown,
      lifetime,
    });
    return this;
  }

  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.bindings.set(token as ServiceToken<unknown>, {
      factory: () => instance,
      lifetime: "singleton",
      cachedInstance: instance,
    });
    return this;
  }

  resolve<T>(token: ServiceToken<T>): T {
    const binding = this.bindings.get(token as ServiceToken<unknown>);
    if (binding) {
      if (binding.lifetime === "singleton") {
        if (binding.cachedInstance === undefined) {
          binding.cachedInstance = binding.factory(this);
        }
        return binding.cachedInstance as T;
      }
      return binding.factory(this) as T;
    }

    if (this.parent) {
      return this.parent.resolve(token);
    }

    throw new Error(`ServiceContainer: No binding registered for token '${token.description}'.`);
  }

  has<T>(token: ServiceToken<T>): boolean {
    if (this.bindings.has(token as ServiceToken<unknown>)) {
      return true;
    }
    return this.parent ? this.parent.has(token) : false;
  }

  createChild(): IContainer {
    return new ServiceContainer(this);
  }
}

/**
 * Standard DI tokens for the Memory Bank infrastructure
 */
export const TOKENS = {
  Logger: createToken<ILogger>("ILogger"),
  Config: createToken<DaemonConfig>("DaemonConfig"),
  ShutdownManager: createToken<unknown>("ShutdownManager"),
  DatabaseResources: createToken<unknown[]>("DatabaseResources"),
} as const;

export class ConsoleLogger implements ILogger {
  constructor(private prefix = "[MemoryBank]") {}

  info(message: string, ...meta: unknown[]): void {
    console.log(`${this.prefix} [INFO] ${message}`, ...meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    console.warn(`${this.prefix} [WARN] ${message}`, ...meta);
  }

  error(message: string, ...meta: unknown[]): void {
    console.error(`${this.prefix} [ERROR] ${message}`, ...meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    console.debug(`${this.prefix} [DEBUG] ${message}`, ...meta);
  }
}
