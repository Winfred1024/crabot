import React, { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { authService } from '../services/auth'
import { Button } from './Common/Button'
import { Input } from './Common/Input'

interface Props {
  onClose: () => void
}

export const ChangePasswordDialog: React.FC<Props> = ({ onClose }) => {
  const { logout } = useAuth()
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (newPwd.length < 4) { setError('新密码至少 4 位'); return }
    if (newPwd !== confirmPwd) { setError('两次输入的密码不一致'); return }

    setLoading(true)
    try {
      await authService.changePassword({ old_password: oldPwd, new_password: newPwd })
      alert('密码已修改，请用新密码重新登录')
      logout()
    } catch (err) {
      const e = err as Error & { body?: { error?: string } }
      if (e.body?.error === 'ADMIN_INVALID_OLD_PASSWORD') {
        setError('旧密码错误')
      } else {
        setError(e.message || '修改失败')
      }
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{ background: 'white', padding: 24, borderRadius: 8, width: 360 }}>
        <h2 style={{ marginTop: 0 }}>修改密码</h2>
        <form onSubmit={handleSubmit}>
          {error && <div className="error-message">{error}</div>}
          <Input type="password" label="旧密码" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} disabled={loading} required />
          <Input type="password" label="新密码" placeholder="至少 4 位" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} disabled={loading} required />
          <Input type="password" label="确认新密码" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} disabled={loading} required />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={loading} style={{ flex: 1 }}>取消</Button>
            <Button type="submit" variant="primary" disabled={loading || !oldPwd || !newPwd || !confirmPwd} style={{ flex: 1 }}>
              {loading ? '提交中...' : '确定'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
