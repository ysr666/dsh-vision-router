// An auto-mount notice is a durable model-visible historical message.
// A plugin generation must never re-append it on HMR/cold Session recovery:
// doing so adds unrequested prompt tokens and moves the cache prefix.
export function hasVisionAutoMountHistoryMarker(messages) {
  return Array.isArray(messages) && messages.some(
    message => typeof message?.id === 'string' &&
      message.id.startsWith('vision-router-auto-mount-'),
  )
}
