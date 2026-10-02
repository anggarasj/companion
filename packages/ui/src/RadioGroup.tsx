import type { ReactNode } from 'react'

export interface RadioOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

export interface RadioGroupProps {
  name: string
  label: string
  options: readonly RadioOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function RadioGroup({
  name,
  label,
  options,
  value,
  onChange,
  disabled = false,
}: RadioGroupProps) {
  return (
    <fieldset className="ui-radio-group" disabled={disabled}>
      <legend>{label}</legend>
      <div className="ui-radio-options">
        {options.map((option) => {
          const selected = value === option.value
          const optionDisabled = disabled || Boolean(option.disabled)
          return (
            <label
              key={option.value}
              className={`ui-radio-option${selected ? ' is-selected' : ''}${
                optionDisabled ? ' is-disabled' : ''
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={optionDisabled}
                onChange={() => onChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
