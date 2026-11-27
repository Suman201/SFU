import { Component, inject } from '@angular/core';
import { API_BASE_URL } from '../../core/services/app-environment';
import { AuthService } from '../../core/services/auth.service';
import { PromotionWorkspace } from '../../../../../frontend/src/app/shared/promotions/promotion-workspace';
@Component({ standalone: true, selector: 'sfu-admin-promotion-commerce', imports: [PromotionWorkspace], template: '<sfu-promotion-workspace [apiBase]="base" [admin]="true" [canContent]="auth.can(\'admin:content:read\')" [canConfigure]="auth.isSuperAdmin()" [canFinanceRead]="auth.can(\'admin:finance:read\')" [canFinanceWrite]="auth.can(\'admin:finance:write\')" />' })
export class AdminPromotionCommerce { protected readonly base = API_BASE_URL; protected readonly auth = inject(AuthService); }
