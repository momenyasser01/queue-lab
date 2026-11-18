import { expect, test, vi } from 'vitest'
import { createShutdown } from '../src/lib/shutdown.js'

const make = () => {
  const exit = vi.fn()
  const shutdown = createShutdown({ graceMs: 1000, log: () => {}, exit })
  return { shutdown, exit }
}

test('runs closers in reverse order and exits 0', async () => {
  const { shutdown, exit } = make()
  const order: string[] = []
  shutdown.add('pool', () => void order.push('pool'))
  shutdown.add('http', () => void order.push('http'))
  shutdown.add('ready', () => void order.push('ready'))

  await shutdown.run('test')

  expect(order).toEqual(['ready', 'http', 'pool'])
  expect(exit).toHaveBeenCalledWith(0)
})

test('runs only once when called twice', async () => {
  const { shutdown, exit } = make()
  const close = vi.fn()
  shutdown.add('a', close)

  await Promise.all([shutdown.run('SIGTERM'), shutdown.run('SIGINT')])

  expect(close).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledTimes(1)
})

test('a failing closer does not stop the rest and exits 1', async () => {
  const { shutdown, exit } = make()
  const last = vi.fn()
  shutdown.add('last', last)
  shutdown.add('broken', () => {
    throw new Error('boom')
  })

  await shutdown.run('test')

  expect(last).toHaveBeenCalled()
  expect(exit).toHaveBeenCalledWith(1)
})
