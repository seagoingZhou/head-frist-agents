import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";


export class EventStream<T, R = T> implements AsyncIterable<T>{

    private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

    constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

    async *[Symbol.asyncIterator](): AsyncIterator<T> {

        // 实现异步迭代器逻辑
        // 从数据源中获取数据并 yield 出去
        while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				// 队列空且未结束 → 挂起一个等待者，由 push/end 唤醒并直接传入结果
				const result = await new Promise<IteratorResult<T>> (
					(resolve) => 
						this.waiting.push(resolve)
				);
				if (result.done) {
					return;
				}
				yield result.value;
			}
		}
    }

	push(event: T): void {
		if (this.done) {
			return;
		}
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(
				this.extractResult(event)
			);
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter(
				{
					value : event,
					done : false
				}
			);
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result)
		}

		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter(
				{
					value : undefined as any,
					done : true
				}
			);
		}
		
	}

    result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
	
}