const InstrumentationEventEmitter = require('../../instrumentation/emitter')
const createProducer = require('../../producer')
const createManualConsumer = require('../index')

const {
  secureRandom,
  createCluster,
  createTopic,
  createModPartitioner,
  newLogger,
  waitFor,
  testIfKafkaAtLeast_0_11,
} = require('testHelpers')

describe('ManualConsumer > Instrumentation Events', () => {
  let topicName, cluster, producer, consumer, consumer2, message, emitter

  const createTestConsumer = (opts = {}) =>
    createManualConsumer({
      cluster,
      logger: newLogger(),
      maxWaitTimeInMs: 500,
      maxBytesPerPartition: 180,
      instrumentationEmitter: emitter,
      ...opts,
    })

  beforeEach(async () => {
    topicName = `test-topic-${secureRandom()}`

    await createTopic({ topic: topicName })

    emitter = new InstrumentationEventEmitter()
    cluster = createCluster({ instrumentationEmitter: emitter, metadataMaxAge: 50 })
    producer = createProducer({
      cluster,
      createPartitioner: createModPartitioner,
      logger: newLogger(),
    })

    message = { key: `key-${secureRandom()}`, value: `value-${secureRandom()}` }
  })

  afterEach(async () => {
    consumer && (await consumer.disconnect())
    consumer2 && (await consumer2.disconnect())
    producer && (await producer.disconnect())
  })

  test('on throws an error when provided with an invalid event name', () => {
    consumer = createTestConsumer()
    expect(() => consumer.on('NON_EXISTENT_EVENT', () => {})).toThrow(
      /Event name should be one of consumer.events./
    )
  })

  it('emits fetch', async () => {
    const onFetch = jest.fn()
    let fetch = 0

    consumer = createTestConsumer()
    consumer.on(consumer.events.FETCH, async event => {
      onFetch(event)
      fetch++
    })

    await consumer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })

    await consumer.run({ eachMessage: () => true })

    await waitFor(() => fetch > 0)
    expect(onFetch).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.fetch',
      payload: {
        numberOfBatches: expect.any(Number),
        duration: expect.any(Number),
        nodeId: expect.any(String),
      },
    })
  })

  it('emits fetch start', async () => {
    const onFetchStart = jest.fn()
    let fetch = 0

    consumer = createTestConsumer()
    consumer.on(consumer.events.FETCH_START, async event => {
      onFetchStart(event)
      fetch++
    })

    await consumer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })

    await consumer.run({ eachMessage: () => true })

    await waitFor(() => fetch > 0)
    expect(onFetchStart).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.fetch_start',
      payload: {
        nodeId: expect.any(String),
      },
    })
  })

  it('emits start batch process', async () => {
    const onStartBatchProcess = jest.fn()
    let startBatchProcess = 0

    consumer = createTestConsumer()
    consumer.on(consumer.events.START_BATCH_PROCESS, async event => {
      onStartBatchProcess(event)
      startBatchProcess++
    })

    await consumer.connect()
    await producer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })
    await consumer.run({ eachMessage: () => true })
    await producer.send({ acks: 1, topic: topicName, messages: [message] })

    await waitFor(() => startBatchProcess > 0)
    expect(onStartBatchProcess).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.start_batch_process',
      payload: {
        topic: topicName,
        partition: 0,
        highWatermark: expect.any(String),
        offsetLag: expect.any(String),
        offsetLagLow: expect.any(String),
        batchSize: 1,
        firstOffset: expect.any(String),
        lastOffset: expect.any(String),
      },
    })
  })

  it('emits end batch process', async () => {
    const onEndBatchProcess = jest.fn()
    let endBatchProcess = 0

    consumer = createTestConsumer()
    consumer.on(consumer.events.END_BATCH_PROCESS, async event => {
      onEndBatchProcess(event)
      endBatchProcess++
    })

    await consumer.connect()
    await producer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })
    await consumer.run({ eachMessage: () => true })
    await producer.send({ acks: 1, topic: topicName, messages: [message] })

    await waitFor(() => endBatchProcess > 0)
    expect(onEndBatchProcess).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.end_batch_process',
      payload: {
        topic: topicName,
        partition: 0,
        highWatermark: expect.any(String),
        offsetLag: expect.any(String),
        offsetLagLow: expect.any(String),
        batchSize: 1,
        firstOffset: expect.any(String),
        lastOffset: expect.any(String),
        duration: expect.any(Number),
      },
    })
  })

  testIfKafkaAtLeast_0_11(
    'emits start and end batch process when reading empty control batches',
    async () => {
      const startBatchProcessSpy = jest.fn()
      const endBatchProcessSpy = jest.fn()

      consumer = createTestConsumer()
      consumer.on(consumer.events.START_BATCH_PROCESS, startBatchProcessSpy)
      consumer.on(consumer.events.END_BATCH_PROCESS, endBatchProcessSpy)

      await consumer.connect()
      await consumer.subscribe({ topic: topicName, fromBeginning: true })
      await consumer.run({ eachMessage: async () => {} })

      producer = createProducer({
        cluster,
        createPartitioner: createModPartitioner,
        logger: newLogger(),
        transactionalId: `test-producer-${secureRandom()}`,
        maxInFlightRequests: 1,
        idempotent: true,
      })

      await producer.connect()
      const transaction = await producer.transaction()

      await transaction.send({
        topic: topicName,
        acks: -1,
        messages: [
          {
            key: 'test',
            value: 'test',
          },
        ],
      })
      await transaction.abort()

      await waitFor(
        () => startBatchProcessSpy.mock.calls.length > 0 && endBatchProcessSpy.mock.calls.length > 0
      )

      expect(startBatchProcessSpy).toHaveBeenCalledWith({
        id: expect.any(Number),
        timestamp: expect.any(Number),
        type: 'consumer.start_batch_process',
        payload: {
          topic: topicName,
          partition: 0,
          highWatermark: '2',
          offsetLag: expect.any(String),
          offsetLagLow: expect.any(String),
          batchSize: 0,
          firstOffset: '0',
          lastOffset: '1',
        },
      })
      expect(startBatchProcessSpy).toHaveBeenCalledTimes(1)

      expect(endBatchProcessSpy).toHaveBeenCalledWith({
        id: expect.any(Number),
        timestamp: expect.any(Number),
        type: 'consumer.end_batch_process',
        payload: {
          topic: topicName,
          partition: 0,
          highWatermark: '2',
          offsetLag: expect.any(String),
          offsetLagLow: expect.any(String),
          batchSize: 0,
          firstOffset: '0',
          lastOffset: '1',
          duration: expect.any(Number),
        },
      })
      expect(endBatchProcessSpy).toHaveBeenCalledTimes(1)
    }
  )

  it('emits connection events', async () => {
    const connectListener = jest.fn().mockName('connect')
    const disconnectListener = jest.fn().mockName('disconnect')
    const stopListener = jest.fn().mockName('stop')

    consumer = createTestConsumer()
    consumer.on(consumer.events.CONNECT, connectListener)
    consumer.on(consumer.events.DISCONNECT, disconnectListener)
    consumer.on(consumer.events.STOP, stopListener)

    await consumer.connect()
    expect(connectListener).toHaveBeenCalled()

    await consumer.run()

    await consumer.disconnect()
    expect(stopListener).toHaveBeenCalled()
    expect(disconnectListener).toHaveBeenCalled()
  })

  it('emits crash events', async () => {
    const crashListener = jest.fn()
    const error = new Error('💣')
    const eachMessage = jest.fn().mockImplementationOnce(() => {
      throw error
    })

    consumer = createTestConsumer({ retry: { retries: 0 } })
    consumer.on(consumer.events.CRASH, crashListener)

    await consumer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })
    await consumer.run({ eachMessage })

    await producer.connect()
    await producer.send({ acks: 1, topic: topicName, messages: [message] })

    await waitFor(() => crashListener.mock.calls.length > 0)

    expect(crashListener).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.crash',
      payload: { error, restart: true },
    })
  })

  it('emits crash events with restart=false', async () => {
    const crashListener = jest.fn()
    const error = new Error('💣💥')
    const eachMessage = jest.fn().mockImplementationOnce(() => {
      throw error
    })

    consumer = createTestConsumer({ retry: { retries: 0, restartOnFailure: async () => false } })
    consumer.on(consumer.events.CRASH, crashListener)

    await consumer.connect()
    await consumer.subscribe({ topic: topicName, fromBeginning: true })
    await consumer.run({ eachMessage })

    await producer.connect()
    await producer.send({ acks: 1, topic: topicName, messages: [message] })

    await waitFor(() => crashListener.mock.calls.length > 0)

    expect(crashListener).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.crash',
      payload: { error, restart: false },
    })
  })

  it('emits request events', async () => {
    const requestListener = jest.fn().mockName('request')

    consumer = createTestConsumer()
    consumer.on(consumer.events.REQUEST, requestListener)

    await consumer.connect()
    expect(requestListener).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.network.request',
      payload: {
        apiKey: 18,
        apiName: 'ApiVersions',
        apiVersion: expect.any(Number),
        broker: expect.any(String),
        clientId: expect.any(String),
        correlationId: expect.any(Number),
        createdAt: expect.any(Number),
        duration: expect.any(Number),
        pendingDuration: expect.any(Number),
        sentAt: expect.any(Number),
        size: expect.any(Number),
      },
    })
  })

  it('emits request timeout events', async () => {
    cluster = createCluster({
      instrumentationEmitter: emitter,
      requestTimeout: 1,
      enforceRequestTimeout: true,
    })
    const requestListener = jest.fn().mockName('request_timeout')

    consumer = createTestConsumer({ cluster })
    consumer.on(consumer.events.REQUEST_TIMEOUT, requestListener)

    await consumer
      .connect()
      .then(() => consumer.run({ eachMessage: () => true }))
      .catch(e => e)

    expect(requestListener).toHaveBeenCalledWith({
      id: expect.any(Number),
      timestamp: expect.any(Number),
      type: 'consumer.network.request_timeout',
      payload: {
        apiKey: expect.any(Number),
        apiName: expect.any(String),
        apiVersion: expect.any(Number),
        broker: expect.any(String),
        clientId: expect.any(String),
        correlationId: expect.any(Number),
        createdAt: expect.any(Number),
        pendingDuration: expect.any(Number),
        sentAt: expect.any(Number),
      },
    })
  })
})
