import {
  backgroundFailurePolicy,
  type BackgroundFailureClass,
  type BackgroundFailurePolicy,
} from '../../../src/lib/vision-background-failure-policy.js'

const failureClass: BackgroundFailureClass = 'protocol'
const policy: Readonly<BackgroundFailurePolicy> =
  backgroundFailurePolicy(failureClass)

const retryable: boolean = policy.retryable
const persist: boolean = policy.persist
const retryAfterMs: number | undefined = policy.retryAfterMs
const ttlMs: number | undefined = policy.ttlMs

void retryable
void persist
void retryAfterMs
void ttlMs

// @ts-expect-error unknown failure classes are not part of the stable policy vocabulary
const invalidClass: BackgroundFailureClass = 'rate-limit'
void invalidClass
