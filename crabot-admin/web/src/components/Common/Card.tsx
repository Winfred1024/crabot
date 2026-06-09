import React from 'react'

type CardVariant = 'default' | 'subtle' | 'outlined'

interface CardProps {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  variant?: CardVariant
  className?: string
}

const variantClass: Record<CardVariant, string> = {
  default: '',
  subtle: 'card--subtle',
  outlined: 'card--outlined',
}

export const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  actions,
  children,
  variant = 'default',
  className = '',
}) => {
  const classes = ['card', variantClass[variant], className].filter(Boolean).join(' ')
  const hasHeader = !!title || !!actions
  return (
    <div className={classes}>
      {hasHeader && (
        <header className="card__header">
          <div className="card__heading">
            {title && <h3 className="card__title">{title}</h3>}
            {subtitle && <div className="card__subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  )
}
