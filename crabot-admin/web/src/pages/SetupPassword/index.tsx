import React, { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { authService } from '../../services/auth'
import { useToast } from '../../contexts/ToastContext'
import { Input } from '../../components/Common/Input'
import { Button } from '../../components/Common/Button'

export const SetupPassword: React.FC = () => {
  const { logout } = useAuth()
  const toast = useToast()
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (newPwd.length < 4) {
      setError('密码至少 4 位')
      return
    }
    if (newPwd !== confirmPwd) {
      setError('两次输入的密码不一致')
      return
    }

    setLoading(true)
    try {
      await authService.changePassword({ new_password: newPwd })
      // 成功后 token 已失效（epoch++），直接 logout 让用户重登
      toast.success('密码修改成功，请用新密码重新登录')
      logout()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '修改失败'
      setError(msg)
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-brand">
          <h1 className="login-title">设置正式密码</h1>
          <p className="login-subtitle">您正在使用临时密码，请设置正式密码后再继续</p>
        </div>

        <div className="login-card">
          <form onSubmit={handleSubmit}>
            {error && <div className="error-message">{error}</div>}

            <Input
              type="password"
              label="新密码"
              placeholder="至少 4 位"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              disabled={loading}
              required
            />
            <Input
              type="password"
              label="确认新密码"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              disabled={loading}
              required
            />

            <Button
              type="submit"
              variant="primary"
              disabled={loading || !newPwd || !confirmPwd}
              style={{ width: '100%', marginBottom: 12 }}
            >
              {loading ? '提交中...' : '设置并继续'}
            </Button>

            <Button
              type="button"
              variant="secondary"
              onClick={logout}
              disabled={loading}
              style={{ width: '100%' }}
            >
              退出登录
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
