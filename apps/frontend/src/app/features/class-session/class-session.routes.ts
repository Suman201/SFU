import { Routes } from '@angular/router';
import { roleGuard } from '../../core/services/auth.guards';
import { StudentClassSession } from './student/class-session';
import { TeacherClassSession } from './teacher/class-session';

export const CLASS_SESSION_ROUTES: Routes = [
  { path: 'teacher', canActivate: [roleGuard], data: { role: 'teacher' }, component: TeacherClassSession },
  { path: 'student', canActivate: [roleGuard], data: { role: 'student' }, component: StudentClassSession },
  { path: '', redirectTo: 'student', pathMatch: 'full' }
];
