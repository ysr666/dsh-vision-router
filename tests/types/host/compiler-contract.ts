type OptionalValue = {
  value?: string
}

const absent: OptionalValue = {}
void absent

// exactOptionalPropertyTypes must distinguish omission from explicit undefined.
// @ts-expect-error explicit undefined is not an omitted optional property
const explicitUndefined: OptionalValue = { value: undefined }
void explicitUndefined

const directory: Record<string, string> = {}
const maybeValue = directory['missing']

// noUncheckedIndexedAccess must preserve the possible absence.
// @ts-expect-error indexed access may be undefined
const definitelyValue: string = maybeValue
void definitelyValue

const contract = {
  mode: 'ordered',
} as const satisfies { mode: 'ordered' | 'auto' }
void contract
