// Own only DVR's reactive routing handles; the Host owns each adapter effect.
// Synchronous topology publication can invalidate this generation mid-call.
export function installReactiveRoutingMounts(ctx, {
  wrapperRoute, chainRoute, routingEnabled, wrapperAdapter, chainAdapter, setWrapperRegistered,
}) {
  let wrapperRouteHandle
  let wrapperRouteMounted
  let chainRouteHandle
  let chainRouteMounted
  let routingMountsClosed = false
  const routingMountsAlive = () => {
    const fiber = ctx?.fiber
    // PENDING and LOADING can own effects; UNLOADING and DISPOSED cannot.
    return !routingMountsClosed && fiber?.uid !== null && fiber?.state !== 4 && fiber?.state !== 5
  }
  const syncRoutingMounts = () => {
    if (!routingMountsAlive()) return
    const wantWrapper = wrapperRoute()
    if (!routingMountsAlive()) return
    if (wantWrapper !== wrapperRouteMounted) {
      const previous = wrapperRouteHandle
      wrapperRouteHandle = undefined
      wrapperRouteMounted = undefined
      setWrapperRegistered(false)
      previous?.()
      if (!routingMountsAlive()) return
      if (wantWrapper !== undefined) {
        try {
          const handle = ctx.llm.registerAdapter([wantWrapper], wrapperAdapter)
          // Adapter publication dispatches Host listeners synchronously. The
          // caller can have been retired before registerAdapter() returns.
          if (!routingMountsAlive()) {
            handle?.()
            return
          }
          wrapperRouteHandle = handle
          wrapperRouteMounted = wantWrapper
          setWrapperRegistered(true)
        } catch (error) {
          if (!routingMountsAlive() && error?.code === 'INACTIVE_EFFECT') return
          if (error?.code === 'DUPLICATE_ADAPTER') {
            if (!routingMountsAlive()) return
            // Another layer already serves this name: adopt it, do not own it.
            wrapperRouteMounted = wantWrapper
            setWrapperRegistered(true)
          } else {
            throw error
          }
        }
      }
    }
    if (!routingMountsAlive()) return
    const wantChain = routingEnabled() ? chainRoute() : undefined
    if (!routingMountsAlive()) return
    if (wantChain !== chainRouteMounted) {
      const previous = chainRouteHandle
      chainRouteHandle = undefined
      chainRouteMounted = undefined
      previous?.()
      if (!routingMountsAlive()) return
      if (wantChain !== undefined) {
        try {
          const handle = ctx.llm.registerAdapter([wantChain], chainAdapter)
          if (!routingMountsAlive()) {
            handle?.()
            return
          }
          chainRouteHandle = handle
          chainRouteMounted = wantChain
        } catch (error) {
          if (!routingMountsAlive() && error?.code === 'INACTIVE_EFFECT') return
          if (error?.code === 'DUPLICATE_ADAPTER') {
            if (!routingMountsAlive()) return
            chainRouteMounted = wantChain
          } else {
            throw error
          }
        }
      }
    }
  }
  ctx.effect(
    () => () => {
      routingMountsClosed = true
      const wrapper = wrapperRouteHandle
      const chain = chainRouteHandle
      wrapperRouteHandle = undefined
      chainRouteHandle = undefined
      wrapperRouteMounted = undefined
      chainRouteMounted = undefined
      setWrapperRegistered(false)
      try { wrapper?.() } finally { chain?.() }
    },
    'vision-router: reactive routing mounts',
  )
  return syncRoutingMounts
}
