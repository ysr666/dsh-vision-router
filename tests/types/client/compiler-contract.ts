const element = document.createElement('div')
element.dataset.dvr = '3.0'
void element

// The Client program must not accidentally inherit Node ambient globals.
// @ts-expect-error Node process is not part of the browser type world
void process

type ClientResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

function renderResult(result: ClientResult) {
  return result.ok ? result.value : result.error
}

void renderResult
