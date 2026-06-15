export interface Permissions {
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  canShareScreen: boolean;
  canChat: boolean;
}

export const DEFAULT_PARTICIPANT_PERMISSIONS: Permissions = {
  canPublishAudio: true,
  canPublishVideo: true,
  canShareScreen: true,
  canChat: true
};

export const VIEWER_PERMISSIONS: Permissions = {
  canPublishAudio: false,
  canPublishVideo: false,
  canShareScreen: false,
  canChat: true
};
