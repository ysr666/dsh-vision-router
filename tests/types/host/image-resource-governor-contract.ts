import {
  ImageResourceGovernor,
  type ImageResourceRelease,
  type ImageResourceStats,
} from '../../../src/lib/image-resource-governor.js'

const governor = new ImageResourceGovernor({
  maxBytes: 1024,
  maxConcurrent: 2,
})

const lease: Promise<ImageResourceRelease> = governor.acquire(512)
const stats: ImageResourceStats = governor.stats()
const value: Promise<number> = governor.withBudget(256, {}, async () => 42)

void lease
void stats
void value
