import { Injectable, signal } from '@angular/core';

const EN = {
  language: 'Classroom language', teacherPreflight: 'Teacher preflight', readyToJoin: 'Ready to join?',
  joinClass: 'Join Class', startClass: 'Start Live Class', leaveClass: 'Leave class', help: 'Help',
  classEnded: 'Class ended', waitingRoom: 'Waiting room', teacherReconnecting: 'Teacher reconnecting',
  stayHere: 'The class is still live. Please stay here.', teacherChat: 'Teacher chat',
  openChat: 'Open class chat', collapseChat: 'Collapse chat', sendMessage: 'Send message',
  raiseHand: 'Raise hand', lowerHand: 'Lower hand', refreshingDevices: 'Refreshing devices',
  switchingMic: 'Switching microphone', switchingCamera: 'Switching camera', startingMedia: 'Starting media',
  teacherDisabledMedia: 'Mic and camera disabled by teacher', teacherDisabledMic: 'Mic disabled by teacher',
  teacherDisabledCamera: 'Camera disabled by teacher', policyLockedMedia: 'Mic and camera locked by class settings',
  policyLockedMic: 'Mic locked by class settings', policyLockedCamera: 'Camera locked by class settings',
  deviceAttention: 'Device needs attention', mediaOff: 'Media off', previewOff: 'Mic off / Camera off',
  previewOn: 'Mic and camera preview on', micPreview: 'Mic preview on', cameraPreview: 'Camera preview on',
  micCameraOff: 'Mic and camera off', micOff: 'Mic off', cameraOff: 'Camera off', mediaOn: 'Mic and camera on',
  micOn: 'Mic on', cameraOn: 'Camera on', whiteboardSource: 'Whiteboard source',
  classroomWhiteboard: 'Classroom whiteboard', deviceWhiteboard: 'Share device whiteboard',
  chatPaused: 'Your teacher has paused your chat. You can still read replies.'
} as const;
const HI: Record<keyof typeof EN, string> = {
  language: 'कक्षा की भाषा', teacherPreflight: 'शिक्षक की तैयारी', readyToJoin: 'जुड़ने के लिए तैयार हैं?',
  joinClass: 'कक्षा में शामिल हों', startClass: 'लाइव कक्षा शुरू करें', leaveClass: 'कक्षा छोड़ें', help: 'सहायता',
  classEnded: 'कक्षा समाप्त', waitingRoom: 'प्रतीक्षा कक्ष', teacherReconnecting: 'शिक्षक फिर से जुड़ रहे हैं',
  stayHere: 'कक्षा अभी चल रही है। कृपया यहीं रहें।', teacherChat: 'शिक्षक से चैट',
  openChat: 'कक्षा चैट खोलें', collapseChat: 'चैट समेटें', sendMessage: 'संदेश भेजें',
  raiseHand: 'हाथ उठाएँ', lowerHand: 'हाथ नीचे करें', refreshingDevices: 'डिवाइस जाँचे जा रहे हैं',
  switchingMic: 'माइक बदला जा रहा है', switchingCamera: 'कैमरा बदला जा रहा है', startingMedia: 'मीडिया शुरू हो रहा है',
  teacherDisabledMedia: 'शिक्षक ने माइक और कैमरा बंद किए हैं', teacherDisabledMic: 'शिक्षक ने माइक बंद किया है',
  teacherDisabledCamera: 'शिक्षक ने कैमरा बंद किया है', policyLockedMedia: 'कक्षा के नियमों से माइक और कैमरा बंद हैं',
  policyLockedMic: 'कक्षा के नियमों से माइक बंद है', policyLockedCamera: 'कक्षा के नियमों से कैमरा बंद है',
  deviceAttention: 'डिवाइस की जाँच करें', mediaOff: 'मीडिया बंद', previewOff: 'माइक बंद / कैमरा बंद',
  previewOn: 'माइक और कैमरा पूर्वावलोकन चालू', micPreview: 'माइक पूर्वावलोकन चालू', cameraPreview: 'कैमरा पूर्वावलोकन चालू',
  micCameraOff: 'माइक और कैमरा बंद', micOff: 'माइक बंद', cameraOff: 'कैमरा बंद', mediaOn: 'माइक और कैमरा चालू',
  micOn: 'माइक चालू', cameraOn: 'कैमरा चालू', whiteboardSource: 'व्हाइटबोर्ड स्रोत',
  classroomWhiteboard: 'कक्षा का व्हाइटबोर्ड', deviceWhiteboard: 'डिवाइस का व्हाइटबोर्ड साझा करें',
  chatPaused: 'शिक्षक ने आपकी चैट रोकी है। आप उत्तर पढ़ सकते हैं।'
};
export type ClassroomLocale = 'en' | 'hi';
export type ClassroomTextKey = keyof typeof EN;
const STORAGE_KEY = 'sapiovian.classroom.locale';

@Injectable({ providedIn: 'root' })
export class ClassroomLocaleService {
  readonly locale = signal<ClassroomLocale>(this.savedLocale());
  text(key: ClassroomTextKey): string { return this.locale() === 'hi' ? HI[key] : EN[key]; }
  setLocale(value: string): void {
    if (value !== 'en' && value !== 'hi') return;
    this.locale.set(value);
    try { globalThis.localStorage?.setItem(STORAGE_KEY, value); } catch { /* Storage may be disabled. */ }
  }
  private savedLocale(): ClassroomLocale {
    try { return globalThis.localStorage?.getItem(STORAGE_KEY) === 'hi' ? 'hi' : 'en'; } catch { return 'en'; }
  }
}
