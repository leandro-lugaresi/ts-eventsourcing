import { AggregateTestContextCollection } from './Context/AggregateTestContextCollection';
import { ReadModelTestContextCollection } from './Context/ReadModelTestContextCollection';
import { Identity } from '../ValueObject/Identity';
import { DomainMessageTestFactory } from './DomainMessageTestFactory';
import { ReadModelTestContext } from './Context/ReadModelTestContext';
import moment from 'moment';
import { SimpleCommandBus } from '../CommandHandling/SimpleCommandBus';
import { CommandBus } from '../CommandHandling/CommandBus';
import { DomainEventBus } from '../EventHandling/DomainEventBus';
import { AsynchronousDomainEventBus } from '../EventHandling/DomainEventBus/AsynchronousDomainEventBus';
import { RecordDomainEventBusDecorator } from '../EventHandling/DomainEventBus/RecordDomainEventBusDecorator';
import { CommandHandler, CommandHandlerConstructor } from '../CommandHandling/CommandHandler';
import {
  EventSourcedAggregateRoot,
  EventSourcedAggregateRootConstructor,
  isEventSourcedAggregateRootConstructor,
} from '../EventSourcing/EventSourcedAggregateRoot';
import { ReadModel, ReadModelConstructor } from '../ReadModel/ReadModel';
import { EventSourcingRepositoryInterface } from '../EventSourcing/EventSourcingRepositoryInterface';
import { EventListenerConstructor, EventListener } from '../EventHandling/EventListener';
import { DomainEvent } from '../Domain/DomainEvent';
import { SimpleDomainEventStream } from '../Domain/SimpleDomainEventStream';
import {
  EventSourcingRepositoryConstructor,
  isEventSourcingRepositoryConstructor,
} from '../EventSourcing/Repository/EventSourcingRepository';
import { Repository } from '../ReadModel/Repository';
import { Command } from '../CommandHandling/Command';
import { DomainMessage } from '../Domain/DomainMessage';
import { DomainEventStream } from '../Domain/DomainEventStream';
import Constructable = jest.Constructable;
import { QueryHandler, QueryHandlerConstructor } from '../QueryHandling/QueryHandler';
import { QueryBus } from '../QueryHandling/QueryBus';
import { SimpleQueryBus } from '../QueryHandling/SimpleQueryBus';
import { Query } from '../QueryHandling/Query';
import * as ErrorStackParser from 'error-stack-parser';
import { StackFrame } from 'error-stack-parser';
import * as extsprintf from 'extsprintf';
import { ClassUtil } from '../ClassUtil';
import { LoggerInterface } from 'triviality-logger/LoggerInterface';
import { ProcessLogger } from 'triviality-logger/ProcessLogger';
import { NullLogger } from 'triviality-logger/NullLogger';
import { PrefixLogger } from 'triviality-logger/PrefixLogger';

export interface TestTask {
  callback: () => Promise<any>;
  description: string;
  stack: StackFrame[];
}

export type Factory<T, TB> = ((testBench: TB) => T)
export type ValueOrFactory<T, TB> = T | Factory<T, TB>;

export type RepositoryReference = EventSourcedAggregateRootConstructor<any> | ReadModelConstructor<any> | string;

/**
 * For testing event sourcing related logic.
 *
 * - Support for multiple read models, aggregates, listeners and command handlers.
 * - It has a fluid interface for all function.
 *
 * Internally it works as a factory for test tasks. All function return a promise and can be waited for to complete the pending tasks.
 */
export class EventSourcingTestBench {
  public static readonly defaultCurrentTime: Date = moment(0).toDate();

  public static create(currentTime?: Date | string) {
    return new this(currentTime);
  }

  public readonly [Symbol.toStringTag]: 'Promise';
  public readonly domainMessageFactory: DomainMessageTestFactory;
  public readonly commandBus: CommandBus = new SimpleCommandBus();
  public readonly queryBus: QueryBus = new SimpleQueryBus();
  public readonly aggregates: AggregateTestContextCollection;
  public readonly models = new ReadModelTestContextCollection();
  public readonly eventBus: DomainEventBus;
  protected readonly asyncBus: AsynchronousDomainEventBus;
  protected readonly recordBus: RecordDomainEventBusDecorator;
  protected breakpoint: boolean = false;
  protected currentTime: Date;
  protected tasks: TestTask[] = [];
  protected errors: Array<unknown> = [];
  protected indent: number = 0;
  private logger: LoggerInterface;

  constructor(currentTime: Date | string = EventSourcingTestBench.defaultCurrentTime) {
    this.currentTime = this.parseDateTime(currentTime);
    this.asyncBus = new AsynchronousDomainEventBus((error) => {
      this.errors.push(error);
    });
    this.recordBus = new RecordDomainEventBusDecorator(this.asyncBus);
    this.eventBus = this.recordBus;
    this.aggregates = new AggregateTestContextCollection(this);
    this.domainMessageFactory = new DomainMessageTestFactory(this);
    this.logger = new NullLogger();
  }

  /**
   * Give a command handler and assigned it to the command bus.
   *
   * @example
   *
   *    // By factory function.
   *    givenCommandHandler((testBench: EventSourcingTestBench) => {
   *      return new OrderCommandHandler(testBench.getAggregateRepository(Order));
   *    })
   *
   *    // By constructor. This will inject the aggregate or model repositories as arguments.
   *    givenCommandHandler(OrderCommandHandler, [Order])
   *    givenCommandHandler(OrderCommandHandler, [Order, User])
   *
   *    // By value
   *    givenCommandHandler(new OrderCommandHandler())
   *
   */
  public givenCommandHandler(createOrHandler: ValueOrFactory<CommandHandler, this>): this;
  public givenCommandHandler(
    constructor: CommandHandlerConstructor,
    classes?: RepositoryReference[],
  ): this;
  public givenCommandHandler(
    createOrConstructor: ValueOrFactory<CommandHandler, this> | (new (...repositories: Array<EventSourcingRepositoryInterface<any>>) => CommandHandler),
    classes: RepositoryReference[] = []) {
    return this.addTask(async () => {
      if (classes.length !== 0 && typeof createOrConstructor === 'function') {
        const handler = this.createClassByRepositoryArguments(createOrConstructor as any, classes);
        this.commandBus.subscribe(handler);
      } else {
        const handler = this.returnValue(createOrConstructor);
        this.commandBus.subscribe(handler);
      }
    });
  }

  /**
   * Give a query handler and assigned it to the query bus.
   *
   * @example
   *
   *    // By factory function.
   *    givenQueryHandler((testBench: EventSourcingTestBench) => {
   *      return new OrderQueryHandler(testBench.getAggregateRepository(Order));
   *    })
   *
   *    // By constructor. This will inject the aggregate or model repositories as arguments.
   *    givenQueryHandler(OrderQueryHandler, [Order])
   *    givenQueryHandler(OrderQueryHandler, [Order, User])
   *
   *    // By value
   *    givenQueryHandler(new OrderQueryHandler())
   *
   */
  public givenQueryHandler(createOrHandler: ValueOrFactory<QueryHandler, this>): this;
  public givenQueryHandler(
    constructor: QueryHandlerConstructor,
    classes?: RepositoryReference[],
  ): this;
  public givenQueryHandler(
    createOrConstructor: ValueOrFactory<QueryHandler, this> | (new (...repositories: Array<EventSourcingRepositoryInterface<any>>) => QueryHandler),
    classes: RepositoryReference[] = []) {
    return this.addTask(async () => {
      if (classes.length !== 0 && typeof createOrConstructor === 'function') {
        const handler = this.createClassByRepositoryArguments(createOrConstructor as any, classes);
        this.queryBus.subscribe(handler);
      } else {
        const handler = this.returnValue(createOrConstructor);
        this.queryBus.subscribe(handler);
      }
    });
  }

  /**
   * Subscribe an event listener or projector to the event bus.
   *
   * @example
   *
   *    // By factory function.
   *    givenEventListener((testBench: EventSourcingTestBench) => {
   *      return new UserLoggedInCountProjector(testBench.getReadModelRepository(UserLogInStatistics));
   *    })
   *
   *    // By constructor. This will inject the aggregate or model repositories as arguments.
   *    givenEventListener(UserLoggedInCountProjector, [Order])
   *    givenEventListener(UserLoggedInCountProjector, [Order, User])
   *
   *    // By value
   *    givenEventListener(new UserLoggedInCountProjector())
   *
   */
  public givenEventListener(createOrEventListener: ValueOrFactory<EventListener, this>): this;
  public givenEventListener(
    constructor: (new (...repositories: Array<EventSourcingRepositoryInterface<any>>) => EventListener) | EventListenerConstructor,
    classes: RepositoryReference[],
  ): this;
  public givenEventListener(
    createOrEventListener: ValueOrFactory<EventListener, this> | EventListenerConstructor,
    classes: RepositoryReference[] = []): this {
    return this.addTask(async () => {
      if (classes.length !== 0 && typeof createOrEventListener === 'function') {
        const handler = this.createClassByRepositoryArguments(createOrEventListener as any, classes);
        this.eventBus.subscribe(handler);
      } else {
        const listener = this.returnValue(createOrEventListener as any);
        this.eventBus.subscribe(listener);
      }
    });
  }

  /**
   * With this you will be able to set spies on repositories, event or command bus etc.
   *
   * @example
   *  let spy = jest.fn();
   *  const testBench = await EventSourcingTestBench
   *                      .create()
   *                      .givenSpies(async (testBenchArg) => {
   *                        spy = jest.spyOn(testBenchArg.eventBus, 'subscribe')
   *                      });
   *  expect(spy).toBeCalledWith('something');
   *
   * @param assignSpies
   */
  public givenSpies(assignSpies: ((testBench: this) => void | Promise<void>)) {
    return this.addTask(async () => assignSpies(this));
  }

  /**
   * Give event that already happened in the past and append them to the corresponding aggregate event store.
   *
   * Keep in mind that these event will not be put on the event bus, use {@see whenEventsHappened} for this.
   */
  public givenEvents<T extends EventSourcedAggregateRoot<Id>, Id extends Identity>(
    id: Id,
    aggregateClass: EventSourcedAggregateRootConstructor<T, Id>,
    events: DomainEvent[]) {
    return this.addTask(async () => {
      const context = this.aggregates.getByConstructor(aggregateClass);
      const domainMessages = this.domainMessageFactory.createDomainMessages(id, events);
      const stream = SimpleDomainEventStream.of(domainMessages);
      return context.getEventStore().append(id, stream);
    });
  }

  /**
   * Change the current date time. This time will be used to change the recordedOn date from domain messages.
   *
   * @param currentTime
   */
  public givenCurrentTime(currentTime: Date | string) {
    return this.addTask(async () => {
      this.currentTime = this.parseDateTime(currentTime);
    });
  }

  /**
   * By default all aggregates have the {@see EventSourcingRepository} class. This is only needed when you have a custom
   * repository class.
   *
   * @example
   *
   *  // Create aggregate repository by factory function.
   *  await EventSourcingTestBench
   *  .create()
   *  .givenAggregateRepository(TestAggregate, (tb) => {
   *       return new TestRepository(
   *         tb.getEventStore(TestAggregate),
   *         tb.getEventBus(),
   *         tb.getAggregateFactory(TestAggregate),
   *         tb.getEventStreamDecorator(TestAggregate),
   *       );
   *   })
   *
   *  // By value
   *  const testBench = new EventSourcingTestBench();
   *  const context = testBench.getAggregateTestContext(TestAggregate);
   *  const repository = new TestRepository(
   *    context.getEventStore(),
   *    testBench.eventBus,
   *    context.getAggregateFactory(),
   *    context.getEventStreamDecorator(),
   *  );
   *  await testBench.givenAggregateRepository(TestAggregate, repository);
   *
   *  // By default constructor signature. {@see EventSourcingRepositoryConstructor} for the arguments of this signature.
   *  .givenAggregateRepository(TestAggregate, TestRepository)
   *
   */
  public givenAggregateRepository<T extends EventSourcedAggregateRoot>(
    aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>,
    repositoryOrFactory: ValueOrFactory<EventSourcingRepositoryInterface<T>, this> | EventSourcingRepositoryConstructor<T>) {
    return this.addTask(async () => {
      const Constructor: any = (repositoryOrFactory as any);
      const aggregateTestContext = this.getAggregateTestContext<T>(aggregateConstructor);
      if (isEventSourcingRepositoryConstructor(Constructor)) {
        const repository = new Constructor(
          aggregateTestContext.getEventStore(),
          this.eventBus,
          aggregateTestContext.getAggregateFactory(),
          aggregateTestContext.getEventStreamDecorator(),
        );
        aggregateTestContext.setRepository(repository);
      } else {
        const repository = this.returnValue(repositoryOrFactory as any);
        aggregateTestContext.setRepository(repository);
      }
    });
  }

  /**
   * @example
   *
   *   // By factory function.
   *   EventSourcingTestBench
   *   .create()
   *   .givenReadModelRepository(TestReadModel, () => {
   *      return new TestRepository();
   *   })
   *
   *   // By value
   *   EventSourcingTestBench
   *   .create()
   *   .givenReadModelRepository(TestReadModel, new TestRepository());
   */
  public givenReadModelRepository<T extends ReadModel>(
    reference: ReadModelConstructor<T> | string,
    repositoryOrFactory: ValueOrFactory<Repository<T>, this>) {
    return this.addTask(async () => {
      const modelTestContext = this.getReadModelTestContext<T>(reference);
      const repository = this.returnValue(repositoryOrFactory as any);
      modelTestContext.setRepository(repository);
    });
  }

  /**
   * Log all test commands to the console, for debugging purposes.
   *
   * @param logger
   */
  public givenTestLogger(logger: LoggerInterface = new ProcessLogger(process)) {
    return this.addTask(async () => {
      this.logger = logger;
    });
  }

  /**
   * Executes a callback function in the flow of the test.
   */
  public given(callback: (testBench: this) => Promise<void> | void): this {
    return this.addTask(() => Promise.resolve(callback(this)));
  }

  /**
   * Can be added before all function to verify the next task throws an error.
   *
   *  await testBench
   *    .throws()
   *    // Or
   *    .throws('Error message')
   *    // Or
   *    .throws(Error)
   *    // Or
   *    .throws(/some error regex/)
   *    .whenEventsHappened([
   *       new TestErrorEvent(),
   *    ]);
   */
  public throws(error?: string | Constructable | RegExp): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const handleTask = this.handleTask;
      this.handleTask = async (task: TestTask) => {
        this.handleTask = handleTask;

        // Jest only support 'toThrowError' for none promises.
        // Catch the error first, and throw it normally.
        let actualError: any = null;
        try {
          await handleTask.call(this, task);

          // Handle all tasks created by the previous task.
          await this.toPromise();
        } catch (e) {
          actualError = e;
        }

        // Throw the error in a normally way.
        expect(() => {
          if (actualError) {
            throw actualError;
          }
        }).toThrowError(error);
      };
    });
  }

  /**
   * Change the current date time. This time will be used to change the recordedOn date from domain messages.
   *
   * @param currentTime
   */
  public whenTimeChanges(currentTime: Date | string) {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      this.currentTime = this.parseDateTime(currentTime);
    });
  }

  /**
   * Dispatch commands on the command bus.
   */
  public whenCommands(commands: Command[]): this {
    return this.addTask(async () => {
      for (const command of commands) {
        await this.commandBus.dispatch(command);
      }
    });
  }

  /**
   * Dispatch domain messages on the event bus.
   *
   * @example
   *
   *     const testBench = new EventSourcingTestBench();
   *
   *     const id = UuidIdentity.create();
   *
   *     await testBench.whenDomainMessagesHappened([
   *       new DomainMessage(id, 0, new TestEvent(), testBench.getCurrentTime()),
   *       new DomainMessage(id, 1, new TestEvent(), testBench.getCurrentTime()),
   *
   *       // You can also create them with domainMessageFactory
   *       testBench.domainMessageFactory.createDomainMessage(id, new TestEvent()),
   *     ]);
   */
  public whenDomainMessagesHappened(messages: DomainMessage[] | DomainEventStream): this {
    return this.addTask(async () => {
      const stream = messages instanceof Array ? SimpleDomainEventStream.of(messages) : messages;
      this.eventBus.publish(stream);
    });
  }

  /**
   * Dispatch events as domain messages on the event bus.
   *
   * @example
   *
   *     const testBench = new EventSourcingTestBench();
   *     const id = UuidIdentity.create();
   *     testBench.whenEventsHappened(id, [
   *        new UserRegistered(),
   *        new UserHasLoggedIn(),
   *        new UserHasLoggedIn(),
   *        new UserHasLoggedIn(),
   *     ]);
   */
  public whenEventsHappened(id: Identity, events: DomainEvent[]): this {
    return this.addTask(async () => {
      const messages = this.domainMessageFactory.createDomainMessages(id, events);
      this.whenDomainMessagesHappened(messages);
    });
  }

  /**
   * Executes a callback function in the flow of the test.
   */
  public when(callback: (testBench: this) => Promise<void> | void): this {
    return this.addTask(() => Promise.resolve(callback(this)));
  }

  /**
   * Put a command on the command bus and match the result.
   */
  public thenCommandHandlerShouldMatchResult(command: Command, expectedResult: any): this {
    return this.addTask(async () => {
      const result = await this.commandBus.dispatch(command);
      expect(result).toMatch(expectedResult);
    });
  }

  /**
   * Put a query on the query bus and match the result.
   */
  public thenQueryHandlerShouldMatchResult(query: Query, expectedResult: any): this {
    return this.addTask(async () => {
      const result = await this.queryBus.dispatch(query);
      expect(result).toMatch(expectedResult);
    });
  }

  /**
   * Match all events that are put the event bus.
   *
   * @example
   *     thenMatchEvents([
   *       new OrderCreated(),
   *       new OrderShipped(),
   *
   *       // Or match full domain message.
   *       new DomainMessage(orderId1, 0, new OrderCreated(), EventSourcingTestBench.defaultCurrentTime)
   *     ]);
   */
  public thenMatchEvents(events: Array<DomainEvent | DomainMessage>): this {
    return this.addTask(async () => {
      const messages = await this.getRecordedMessages();
      const actualEvents = messages.map((message, index) => {
        if (events[index] instanceof DomainMessage) {
          return message;
        }
        return message.payload;
      });
      await expect(actualEvents).toEqual(events);
    });
  }

  /**
   * Assert read models, the actual models are retrieved by id from the corresponding repository.
   *
   * @example
   *
   *   // By value
   *   const id = UserId.create();
   *   const expectedModel = new UserLogInStatistics(id);
   *   expectedModel.increaseCount();
   *
   *   await EventSourcingTestBench
   *   .create()
   *   .thenModelsShouldMatch([
   *      expectedModel,
   *   ]);
   *
   *
   *   // By factory
   *   await EventSourcingTestBench
   *   .create()
   *   .thenModelsShouldMatch(() => {
   *      const id = UserId.create();
   *      const expectedModel = new UserLogInStatistics(id);
   *      expectedModel.increaseCount();
   *      return [
   *        expectedModel,
   *      ];
   *   });
   */
  public thenModelsShouldMatch<T extends ReadModel>(modelsOrFactory: ValueOrFactory<T[], this>): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const models = this.returnValue(modelsOrFactory);
      for (const model of models) {
        const repository = this.models.getByInstance(model).getRepository();
        const actual = await repository.get(model.getId());
        await expect(actual).toEqual(model);
      }
    });
  }

  public thenAggregatesShouldMatchSnapshot(snapshotName?: string): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const aggregates = await this.aggregates.getAllAggregates();
      expect(aggregates).toMatchSnapshot(snapshotName);
    });
  }

  public thenMessagesShouldMatchSnapshot(snapshotName?: string): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const messages = await this.aggregates.getAllMessages();
      expect(messages).toMatchSnapshot(snapshotName);
    });
  }

  public thenEventsShouldMatchSnapshot(snapshotName?: string): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const events = await this.aggregates.getAllEvents();
      expect(events).toMatchSnapshot(snapshotName);
    });
  }

  public thenModelsShouldMatchSnapshot(snapshotName?: string): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const models = await this.models.getAllModels();
      expect(models).toMatchSnapshot(snapshotName);
    });
  }

  /**
   * Match all models, events and aggregates.
   */
  public thenShouldMatchSnapshot(snapshotName?: string): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const data: {
        aggregates?: { [aggregateClassName: string]: EventSourcedAggregateRoot[] },
        messages?: { [aggregateClassName: string]: DomainMessage[] },
        models?: { [aggregateClassName: string]: ReadModel[] },
      } = {};
      const aggregates = await this.aggregates.getAllAggregates();
      if (Object.getOwnPropertyNames(aggregates).length !== 0) {
        data.aggregates = aggregates;
      }
      const messages = await this.aggregates.getAllMessages();
      if (Object.getOwnPropertyNames(messages).length !== 0) {
        data.messages = messages;
      }
      const models = await this.models.getAllModels();
      if (Object.getOwnPropertyNames(models).length !== 0) {
        data.models = models;
      }
      expect(data).toMatchSnapshot(snapshotName);
    });
  }

  /**
   * Assert a single read model by a given matcher function.
   *
   * @example
   *  thenAssertModel(UserLogInStatistics, id, async (model, _testBench: EventSourcingTestBench) => {
   *    expect(model.getCount()).toEqual(3);
   *  });
   */
  public thenAssertModel<T extends ReadModel>(
    reference: ReadModelConstructor<T> | string,
    id: Identity,
    matcher: (model: T, testBench: this) => Promise<void> | void,
  ): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      const repository = this.getReadModelTestContext(reference).getRepository();
      const model = await repository.get(id);
      await matcher(model, this);
    });
  }

  /**
   * Custom assert function, can do any assertions in here.
   *
   * @example
   *
   * .thenAssert(async (testBench) => {
   *   // Verify repository.
   *   const orderRepository = testBench.getAggregateRepository(Order);
   *   expect(await orderRepository.load(id)).toBeInstanceOf(Order);
   *
   *   // Verify event store.
   *   const store = testBench.getEventStore(Order);
   *   const stream = await store.load(id);
   *   expect(await stream.pipe(toArray()).toPromise()).toEqual([
   *     new DomainMessage(id, 0, new OrderCreated(), testBench.getCurrentTime()),
   *   ]);
   *
   *   // Verify all recorded messages
   *   const messages = await testBench.getRecordedMessages();
   *   expect(messages).toEqual([
   *     new DomainMessage(id, 0, new OrderCreated(), testBench.getCurrentTime()),
   *   ]);
   *
   *   // Verify event by test bench.
   *   await testBench.thenMatchEvents([new OrderCreated()]);
   * });
   */
  public thenAssert(asserting: (testBench: this) => Promise<void> | void): this {
    return this.addTask(async () => {
      await this.thenWaitUntilProcessed();
      await asserting(this);
    });
  }

  public getAggregateRepository<T extends EventSourcedAggregateRoot>(aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>) {
    return this.getAggregateTestContext<T>(aggregateConstructor).getRepository();
  }

  public getEventStore<T extends EventSourcedAggregateRoot>(aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>) {
    return this.getAggregateTestContext<T>(aggregateConstructor).getEventStore();
  }

  public getEventStreamDecorator<T extends EventSourcedAggregateRoot>(aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>) {
    return this.getAggregateTestContext<T>(aggregateConstructor).getEventStreamDecorator();
  }

  public getAggregateFactory<T extends EventSourcedAggregateRoot>(aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>) {
    return this.getAggregateTestContext<T>(aggregateConstructor).getAggregateFactory();
  }

  public getReadModelRepository<T extends ReadModel>(reference: ReadModelConstructor<T> | string): Repository<T> {
    return this.getReadModelTestContext<T>(reference).getRepository();
  }

  public getReadModelTestContext<T extends ReadModel>(reference: ReadModelConstructor<T> | string): ReadModelTestContext<T> {
    if (typeof reference === 'string') {
      return this.models.getByName(reference);
    }
    return this.models.getByConstructor(reference);
  }

  public getAggregateTestContext<T extends EventSourcedAggregateRoot>(aggregateConstructor: EventSourcedAggregateRootConstructor<T, any>) {
    return this.aggregates.getByConstructor<T>(aggregateConstructor);
  }

  public getLogger(indent: number = 0): LoggerInterface {
    const totalIndent = this.indent + indent;
    if (totalIndent !== 0) {
      return PrefixLogger.with(this.logger, extsprintf.sprintf(`%${totalIndent * 3}s`, ''));
    }
    return this.logger;
  }

  public thenWaitUntilProcessed() {
    return this.addTask(async () => {
      await this._thenWaitUntilProcessed();
    });
  }

  /* istanbul ignore next */
  public thenIPutABeakpoint() {
    return this.addTask(async () => {
      this.breakpoint = true;
    });
  }

  public async getRecordedMessages() {
    await this.thenWaitUntilProcessed();
    return this.recordBus.getMessages();
  }

  public getCurrentTime(): Date {
    return this.currentTime;
  }

  public getEventBus(): DomainEventBus {
    return this.eventBus;
  }

  /**
   * This will handle all the synchronously.
   */
  public async toPromise() {
    const tasks = this.tasks;
    this.tasks = [];
    for (const task of tasks) {
      // The task name for easy referencing.
      const description = task.description;
      this.getLogger().info(description);
      await this.handleTask(task);

      await this._thenWaitUntilProcessed();

      // Handle all tasks created by the previous task.
      await this.toPromise();
    }
  }

  protected parseDateTime(date: Date | string): Date {
    const parsed = moment(date);
    if (!parsed.isValid()) {
      throw new Error(`Date is not valid ${date.toString()}`);
    }
    return parsed.toDate();
  }

  protected returnValue<T>(valueOrFactory: ValueOrFactory<T, this>): T {
    return typeof valueOrFactory === 'function' ? (valueOrFactory as Factory<T, this>)(this) : valueOrFactory;
  }

  protected addTask(callback: () => Promise<void>, ignore: number = 1): this {
    const stack = ErrorStackParser.parse(new Error());
    const realStack: StackFrame[] = stack.slice(ignore);

    const testFunction: StackFrame = realStack[0];
    const userFunction: StackFrame = realStack[1];

    const directory = process.cwd();
    /* istanbul ignore next */
    const fileName = userFunction.fileName || '';
    const strippedPath = fileName.replace(`${directory}/`, '');
    /* istanbul ignore next */
    const functionName = testFunction.functionName || '';
    const name = ClassUtil.nameOffInstance(this);
    this.indent = realStack.reduce(
      (prev, trace) => {
        if (trace.functionName && trace.functionName.indexOf('.addTask') >= 0) {
          return prev + 1;
        }
        return prev;
      },
      0,
    );

    const description = extsprintf.sprintf(
      '%-60s %s',
      `${strippedPath}:${userFunction.lineNumber}:${userFunction.columnNumber}`,
      functionName.replace(`${name}.`, ''),
    );
    /* istanbul ignore next */
    return this.addPending({ stack, callback, description });
  }

  /* tslint:disable:no-debugger */
  protected handleTask(task: TestTask): Promise<any> {
    /* istanbul ignore next */
    if (this.breakpoint) {
      this.breakpoint = false;
      // 'Step into' to see what the next task is going to do.
      debugger;
    }
    return Promise.resolve(task.callback.call(this));
  }

  /* tslint:enable:no-debugger */

  /**
   * For internal use, to prevent curlier loop inside the toPromise function.
   * @private
   */
  protected async _thenWaitUntilProcessed() {
    await this.asyncBus.untilIdle();
    // Throw first error, generated on the bus.
    if (this.errors.length) {
      throw this.errors.shift();
    }
  }

  private addPending(pending: TestTask): this & Promise<this> {
    this.tasks.push(pending);
    // next in chain.
    if (typeof (this as any).then === 'function') {
      return this as any;
    }

    (this as any).then = this.thenPromise.bind(this);
    return this as any;
  }

  private thenPromise<TResult1 = this, TResult2 = never>(onfulfilled?: ((value: this) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
    return this.toPromise().then(() => {
      // remove promise function, so it can be returned.
      (this as any).then = undefined;
      return this;
    }).then(onfulfilled, onrejected);
  }

  private createClassByRepositoryArguments(
    constructor: CommandHandlerConstructor | EventListenerConstructor,
    references: RepositoryReference[]) {
    const repositories = references.map((reference) => {
      if (isEventSourcedAggregateRootConstructor(reference)) {
        return this.getAggregateTestContext(reference).getRepository();
      }
      return this.getReadModelTestContext(reference).getRepository();
    });
    this.getLogger(1).info(`Created class ${ClassUtil.nameOffConstructor(constructor)} with arguments:`);
    repositories.map((repository, index) => {
      const reference = references[index];
      const referenceTitle = typeof reference === 'string' ? reference : ClassUtil.nameOffConstructor(reference);
      this.getLogger(2).info(extsprintf.sprintf(`%20s --> ${ClassUtil.nameOffInstance(repository)}`, referenceTitle));
    });
    return new (constructor as any)(...repositories);
  }

}
