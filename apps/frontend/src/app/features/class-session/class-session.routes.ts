import { Routes } from '@angular/router';
import { StudentClassSession } from './student/class-session';
import { TeacherClassSession } from './teacher/class-session';

export const CLASS_SESSION_ROUTES: Routes = [
  { path: 'teacher', component: TeacherClassSession },
  { path: 'student', component: StudentClassSession },
  { path: '', redirectTo: 'student', pathMatch: 'full' }
];
