export interface IEventEmitter<TEvents extends Record<string, (...args: any[]) => void>> {
    subscribe<E extends keyof TEvents>(event: E, callback: TEvents[E]): () => void;
    unsubscribe<E extends keyof TEvents>(event: E, callback: TEvents[E]): void;
}

export abstract class EventEmitter<TEvents extends Record<string, (...args: any[]) => void>> 
    implements IEventEmitter<TEvents> 
{
    private subscribers: { [E in keyof TEvents]?: TEvents[E][] } = {};

    subscribe<E extends keyof TEvents>(event: E, callback: TEvents[E]): () => void {
        if (!this.subscribers[event])
            this.subscribers[event] = [];
        this.subscribers[event]!.push(callback);
        return () => this.unsubscribe(event, callback);
    }

    unsubscribe<E extends keyof TEvents>(event: E, callback: TEvents[E]) {
        this.subscribers[event] = this.subscribers[event]?.filter(cb => cb !== callback) as any;
    }

    protected notify<E extends keyof TEvents>(event: E, ...args: Parameters<TEvents[E]>) {
        this.subscribers[event]?.forEach(cb => (cb as (...a: any[]) => void)(...args));
    }
}