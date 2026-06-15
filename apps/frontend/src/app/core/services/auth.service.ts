import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { tap } from 'rxjs';
import { API_BASE_URL } from './app-environment';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly authenticated = signal(Boolean(localStorage.getItem('sfu.accessToken')));

  constructor(private readonly http: HttpClient) {}

  register(displayName: string, email: string, password: string) {
    return this.http
      .post<TokenPair>(`${API_BASE_URL}/auth/register`, { displayName, email, password })
      .pipe(tap((tokens) => this.store(tokens)));
  }

  login(email: string, password: string) {
    return this.http.post<TokenPair>(`${API_BASE_URL}/auth/login`, { email, password }).pipe(tap((tokens) => this.store(tokens)));
  }

  logout(): void {
    localStorage.removeItem('sfu.accessToken');
    localStorage.removeItem('sfu.refreshToken');
    this.authenticated.set(false);
  }

  accessToken(): string | null {
    return localStorage.getItem('sfu.accessToken');
  }

  private store(tokens: TokenPair): void {
    localStorage.setItem('sfu.accessToken', tokens.accessToken);
    localStorage.setItem('sfu.refreshToken', tokens.refreshToken);
    this.authenticated.set(true);
  }
}
