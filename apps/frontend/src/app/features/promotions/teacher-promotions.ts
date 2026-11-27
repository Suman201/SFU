import { Component } from '@angular/core';
import { API_BASE_URL } from '../../core/services/app-environment';
import { PromotionWorkspace } from '../../shared/promotions/promotion-workspace';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
@Component({ standalone: true, selector: 'sfu-teacher-promotions', imports: [Header, Footer, PromotionWorkspace], template: '<sfu-header/><main class="site-page"><sfu-promotion-workspace [apiBase]="base" /></main><sfu-footer/>' })
export class TeacherPromotions { protected readonly base = API_BASE_URL; }
