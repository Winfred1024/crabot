import React from 'react'

type InputSize = 'sm' | 'md'

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  error?: string
  help?: string
  size?: InputSize
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  help,
  size = 'md',
  className = '',
  id,
  ...props
}) => {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const classes = [
    'input',
    size === 'sm' ? 'input--sm' : '',
    error ? 'input--error' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="form-group">
      {label && <label className="form-label" htmlFor={inputId}>{label}</label>}
      <input id={inputId} className={classes} {...props} />
      {help && !error && <span className="form-help">{help}</span>}
      {error && <span className="form-help form-help--error">{error}</span>}
    </div>
  )
}
