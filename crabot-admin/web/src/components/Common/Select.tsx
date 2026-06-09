import React from 'react'

type SelectSize = 'sm' | 'md'

interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string
  options: Array<{ value: string; label: string }>
  error?: string
  help?: string
  size?: SelectSize
}

export const Select: React.FC<SelectProps> = ({
  label,
  options,
  error,
  help,
  size = 'md',
  className = '',
  id,
  ...props
}) => {
  const generatedId = React.useId()
  const selectId = id ?? generatedId
  const classes = [
    'select',
    size === 'sm' ? 'select--sm' : '',
    error ? 'select--error' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="form-group">
      {label && <label className="form-label" htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={classes} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help && !error && <span className="form-help">{help}</span>}
      {error && <span className="form-help form-help--error">{error}</span>}
    </div>
  )
}
