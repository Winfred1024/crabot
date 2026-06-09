/**
 * 认证服务
 */

import { api } from './api'
import { storage } from '../utils/storage'
import type { LoginRequest, LoginResponse, ChangePasswordRequest, MeResponse } from '../types'

export const authService = {
  async login(password: string): Promise<LoginResponse> {
    const response = await api.post<LoginResponse>('/auth/login', {
      password,
    } as LoginRequest)

    storage.setToken(response.token, response.expires_at)

    return response
  },

  async getMe(): Promise<MeResponse> {
    return api.get<MeResponse>('/auth/me')
  },

  async changePassword(req: ChangePasswordRequest): Promise<void> {
    await api.post<void>('/auth/change-password', req)
  },

  logout(): void {
    storage.clearToken()
    window.location.href = '/login'
  },

  isAuthenticated(): boolean {
    return storage.isAuthenticated()
  },
}
