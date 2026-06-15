import { Routes } from '@angular/router';
import { LobbyComponent } from './features/lobby/lobby.component';
import { RoomComponent } from './features/room/room.component';

export const routes: Routes = [
  { path: '', component: LobbyComponent },
  { path: 'rooms/:roomId', component: RoomComponent },
  { path: '**', redirectTo: '' }
];
