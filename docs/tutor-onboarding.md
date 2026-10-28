# Tutor profiles and teaching catalogue

The teacher profile editor uses the existing account/backend. It separates About you, Subjects & learners, Introduction video, Experience, Teaching assessment, and Review & submit. `/teacher/profile` is the teacher entry point. Admin routes are `/teaching-catalog` and `/tutor-applications`.

## Catalogue

The seed includes 18 broad categories, 268 subjects, and 80 curriculum/exam classifications across 51 European and transcontinental markets. This is an editable starting catalogue, not a claim to enumerate every national or regional curriculum. Countries, learner ages, teaching levels, subjects, and curricula are separate fields.

```sh
npm run seed:teaching-catalog
# Repository Docker development MongoDB uses host port 27018:
MONGODB_URI=mongodb://127.0.0.1:27018/native_sfu npm run seed:teaching-catalog
```

The script adds missing defaults, preserves IDs and admin edits (including renames and archives), and never seeds accounts. Remote database execution needs an explicit URI and `--allow-remote` on the backend workspace script. Admins can add/edit/archive/restore entries; optimistic versions prevent stale overwrites. A category containing active subjects cannot be archived. Existing archived selections remain removable from teacher drafts but block submission.

## Video and review

Teachers can upload MP4/WebM up to 50 MiB and 180 seconds, or save a direct HTTPS YouTube/Vimeo video URL. We recommend 1–2 minutes. Uploaded files are checked by signature and ffprobe for a supported video codec/duration, stored privately, and streamed with byte-range support. Replacing a file or saving a link removes the previous uploaded file after the profile update succeeds. Files are never served through the generic profile image endpoint. Drafts are available to the owner and admin reviewers; public playback requires an active approved public profile. Third-party video visibility depends on its provider settings; reviewers must confirm playback.

Each selected category has a configurable assessment method/instructions. Teachers submit a worked response and optional supporting sample. An administrator records each category outcome with notes and watches the intro video before approval. This is a manual assessment workflow, not an automatic quiz, identity verification service, or background check provider. Identity/adult eligibility, teaching suitability, and applicable child safeguarding checks must actually be completed before recording their outcomes. Do not place identity documents in public media or notes.

Draft → submitted → approved / changes requested / rejected. Teacher profile or media changes increment the revision, hide the public profile, and require a new review. Admins cannot review their own profile. Stale profile/review submissions are rejected. **Existing teachers require review before their public listing is shown**; there is no silent grandfathered approval. Teaching/classroom access is unchanged by listing approval.

## Deployment

ffprobe is supplied by FFmpeg in the backend image. The default private storage path is `PROFILE_MEDIA_LOCAL_PATH/tutor-introductions`. Set `TUTOR_INTRO_VIDEO_LOCAL_PATH` to a private shared directory when using multiple API replicas. The multi-node Docker Compose configuration mounts one shared video volume on both nodes. The single-node production and Kubernetes paths use the existing profile media volume. Do not expose this directory as static files. Ensure the reverse proxy accepts multipart uploads above 50 MiB and persistent storage is backed up. No installer rebuild is needed for backend/admin changes; desktop packaging remains a separate operation.

Country-specific onboarding, safeguarding procedures, minors' guardian consent, retention, and other launch obligations need operational/legal implementation appropriate to each market. These UI review controls do not establish Europe-wide legal compliance.

## Verification

`tests/browser/tutor-onboarding-acceptance.spec.ts` runs headlessly against the real Nest backend, isolated MongoDB `whiteboard_acceptance`, Redis, and Angular UI. It covers catalogue counts/permissions/CRUD/stale versions/reseeding, rejected invalid inputs, upload/preview, draft privacy, teacher submission, review prerequisites, admin video playback and approval, public range playback, marketplace subject filtering, edit invalidation, link replacement, and mobile width. It uses a synthetic video fixture; no live account or real applicant is approved. Backend unit tests cover link validation and streaming. Teacher editor tests cover failed upload/preview recovery.
