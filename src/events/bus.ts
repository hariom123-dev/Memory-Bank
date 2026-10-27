import type { z } from "zod";
import type { ILogger } from "../daemon/types.js";

export type EventHandler<T> = (payload: T) => void | Promise<void>;
export type WildcardHandler<TMap> = <K extends keyof TMap>(
  event: K,
  payload: TMap[K]
) => void | Promise<void>;

export interface SubscriptionOptions<T> {
  id?: string;
  once?: boolean;
  priority?: number; // Higher number executes earlier
  filter?: (payload: T) => boolean;
}

export interface PublishResult {
  event: string;
  listenerCount: number;
  success: boolean;
  errors: Array<{ handlerId: string; error: Error }>;
}

interface InternalSubscription<T> {
  id: string;
  handler: EventHandler<T>;
  once: boolean;
  priority: number;
  filter?: ((payload: T) => boolean) | undefined;
}

export interface TypedEventBusOptions<TMap extends Record<string, unknown>> {
  logger?: ILogger;
  validatePayloads?: boolean;
  schemas?: Partial<{ [K in keyof TMap]: z.ZodType<TMap[K]> }>;
}

export class TypedEventBus<TMap extends Record<string, unknown>> {
  private listeners = new Map<keyof TMap, Array<InternalSubscription<unknown>>>();
  private wildcardListeners = new Set<WildcardHandler<TMap>>();
  private logger?: ILogger | undefined;
  private validatePayloads: boolean;
  private schemas?: Partial<{ [K in keyof TMap]: z.ZodType<TMap[K]> }> | undefined;
  private nextHandlerId = 1;

  constructor(options: TypedEventBusOptions<TMap> = {}) {
    this.logger = options.logger;
    this.validatePayloads = options.validatePayloads ?? false;
    this.schemas = options.schemas;
  }

  /**
   * Subscribes to an event with optional filter, priority, or once configuration.
   * Returns an unsubscribe function.
   */
  subscribe<K extends keyof TMap>(
    event: K,
    handler: EventHandler<TMap[K]>,
    options: SubscriptionOptions<TMap[K]> = {}
  ): () => void {
    const handlerId = options.id ?? `handler_${String(event)}_${this.nextHandlerId++}`;
    const subscription: InternalSubscription<TMap[K]> = {
      id: handlerId,
      handler,
      once: options.once ?? false,
      priority: options.priority ?? 0,
      filter: options.filter,
    };

    const currentListeners = this.listeners.get(event) ?? [];
    currentListeners.push(subscription as InternalSubscription<unknown>);
    // Sort descending by priority
    currentListeners.sort((a, b) => b.priority - a.priority);
    this.listeners.set(event, currentListeners);

    return () => this.unsubscribe(event, handlerId);
  }

  /**
   * Subscribes to an event for a single trigger, then automatically unsubscribes.
   */
  subscribeOnce<K extends keyof TMap>(
    event: K,
    handler: EventHandler<TMap[K]>,
    options: Omit<SubscriptionOptions<TMap[K]>, "once"> = {}
  ): () => void {
    return this.subscribe(event, handler, { ...options, once: true });
  }

  /**
   * Subscribes a wildcard handler to all published events.
   * Useful for centralized logging, audit trails, and the TUI monitor.
   */
  subscribeAll(handler: WildcardHandler<TMap>): () => void {
    this.wildcardListeners.add(handler);
    return () => {
      this.wildcardListeners.delete(handler);
    };
  }

  /**
   * Publishes an event with payload to all registered and wildcard listeners.
   * Validates schema (if enabled) and ensures error isolation across handlers.
   */
  async publish<K extends keyof TMap>(event: K, payload: TMap[K]): Promise<PublishResult> {
    const eventKey = String(event);

    // Validate payload if validation is configured
    if (this.validatePayloads && this.schemas) {
      const schema = this.schemas[event];
      if (schema) {
        const parseResult = schema.safeParse(payload);
        if (!parseResult.success) {
          const validationError = new Error(
            `Payload validation failed for event '${eventKey}': ${parseResult.error.message}`
          );
          this.logger?.error(validationError.message);
          return {
            event: eventKey,
            listenerCount: 0,
            success: false,
            errors: [{ handlerId: "schema_validation", error: validationError }],
          };
        }
      }
    }

    const listeners = [...(this.listeners.get(event) ?? [])];
    const errors: Array<{ handlerId: string; error: Error }> = [];
    const handlersToRemove: string[] = [];

    // Execute event listeners
    for (const sub of listeners) {
      if (sub.filter && !sub.filter(payload)) {
        continue;
      }

      if (sub.once) {
        handlersToRemove.push(sub.id);
      }

      try {
        await sub.handler(payload);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger?.error(`Error in event listener '${sub.id}' for event '${eventKey}':`, error);
        errors.push({ handlerId: sub.id, error });
      }
    }

    // Clean up one-time listeners
    for (const handlerId of handlersToRemove) {
      this.unsubscribe(event, handlerId);
    }

    // Execute wildcard listeners
    for (const wildcard of this.wildcardListeners) {
      try {
        await wildcard(event, payload);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger?.error(`Error in wildcard listener for event '${eventKey}':`, error);
        errors.push({ handlerId: "wildcard_listener", error });
      }
    }

    return {
      event: eventKey,
      listenerCount: listeners.length + this.wildcardListeners.size,
      success: errors.length === 0,
      errors,
    };
  }

  unsubscribe<K extends keyof TMap>(event: K, handlerId: string): boolean {
    const currentListeners = this.listeners.get(event);
    if (!currentListeners) return false;

    const initialLen = currentListeners.length;
    const filtered = currentListeners.filter((s) => s.id !== handlerId);
    if (filtered.length < initialLen) {
      this.listeners.set(event, filtered);
      return true;
    }
    return false;
  }

  listenerCount<K extends keyof TMap>(event?: K): number {
    if (event !== undefined) {
      return (this.listeners.get(event)?.length ?? 0) + this.wildcardListeners.size;
    }
    let count = 0;
    for (const list of this.listeners.values()) {
      count += list.length;
    }
    return count + this.wildcardListeners.size;
  }

  hasListeners<K extends keyof TMap>(event: K): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0 || this.wildcardListeners.size > 0;
  }

  clearListeners<K extends keyof TMap>(event?: K): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
      this.wildcardListeners.clear();
    }
  }
}
