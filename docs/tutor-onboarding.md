# Tutor profiles and teaching catalogue

The teacher profile editor uses the existing account/backend. It separates About you, Subjects & learners, Introduction video, Experience (including private verification), Teaching assessment, and Review & submit. `/teacher/profile` is the teacher entry point. Admin routes are `/teaching-catalog` and `/tutor-applications`.

## Catalogue

The seed includes 18 top-level categories with 18 nested branches, 270 subjects, seven academic levels, 67 teaching languages, and 80 curriculum/exam classifications across 51 European and transcontinental markets. This is an editable starting catalogue, not a claim to enumerate every national or regional curriculum. Countries, learner ages, academic levels, subjects, teaching languages, and curricula are separate concepts. Academic level means the stage a tutor teaches (primary, secondary, undergraduate, postgraduate, and so on), not language fluency or a generic beginner/advanced rating.

```sh
npm run seed:teaching-catalog
# Repository Docker development MongoDB uses host port 27018:
MONGODB_URI=mongodb://127.0.0.1:27018/native_sfu npm run seed:teaching-catalog
```

The script adds missing defaults, preserves IDs and admin edits (including renames and archives), and never seeds accounts. Remote database execution needs an explicit URI and `--allow-remote` on the backend workspace script. Admins can add/edit/archive/restore entries; optimistic versions prevent stale overwrites. Categories support nested parents. Moves that create cycles and archiving a category with active direct children are rejected. Catalogue mutations are serialized with a database lease across API replicas; a crashed operation releases its lease after five minutes. A category containing active subjects cannot be archived. Existing archived selections remain removable from teacher drafts but block submission.

## Teaching areas

Teachers add any number of teaching areas. Each area links one category to optional subject specialisms, one or more academic levels, and one or more teaching languages. A tutor can offer primary and secondary mathematics in English, alongside university physics in French. There is no business limit of eight subjects or categories, and assessments/review results have no corresponding count cap. Profile and admin review JSON submissions use a 1 MB transport envelope; unrelated routes retain their existing limits.

Choosing a category without specific subjects means general teaching in that category; it does not automatically claim every specialist subject. Category search includes descendants. Student category, subject, academic-level and teaching-language filters must match the **same teaching area**. Public profiles and admin reviews display these relationships.

“Other / subject not listed” records named subjects, academic levels and teaching languages. It has no preset category assessment and can be the teacher’s only teaching area. Introduction video, experience, declarations, and admin teaching-suitability review still apply. Mixed profiles retain assessments for every selected catalogue category and academic level. Custom names become public and searchable only after profile approval; they do not automatically alter the shared catalogue.

Existing flat subject selections are shown as teaching areas when editing. Tutors select academic levels before the next submission. Explicit teaching areas are authoritative; flattened subject, language and academic-level fields are derived for compatibility. Archived entries can remain in a draft but must be replaced before submission. Admin edits and catalogue reseeding retain stable IDs; untouched seeded subjects are moved into starter subcategories without replacing their IDs.

## Video and review

Teachers can upload MP4/WebM up to 50 MiB and 180 seconds, or save a direct HTTPS YouTube/Vimeo video URL. We recommend 1–2 minutes. Uploaded files are checked by signature and ffprobe for a supported video codec/duration, stored privately, and streamed with byte-range support. Replacing a file or saving a link removes the previous uploaded file after the profile update succeeds. Files are never served through the generic profile image endpoint. Drafts are available to the owner and admin reviewers; public playback requires an active approved public profile. Third-party video visibility depends on its provider settings; reviewers must confirm playback.

Each selected category and academic level has its own task and response. Academic levels provide editable stage-appropriate guidance: primary tasks use concrete examples and age-appropriate checks; undergraduate and postgraduate tasks require progressively rigorous reasoning. Category admins can add a task override for a particular academic level. A nearest ancestor override is inherited by subcategories until they define their own override for that level. Other subjects skip these preset tasks.

Teachers submit a separate response and optional supporting sample for each category/level pair. Administrators record separate outcomes and notes for each pair and watch the introduction video before approval. Task versions include category, inherited policy and academic-level versions. Updated instructions make prior answers and review results stale; teachers retain a stale draft for correction, and submission/approval reject it until updated. Catalogue changes are serialized with submission and review decisions, preventing a policy edit during validation and approval. Legacy category-only answers do not fulfil a new academic-level task. This is a manual assessment workflow, not an automatic quiz, identity verification service, or background check provider. Identity/adult eligibility, teaching suitability, and applicable child safeguarding checks must actually be completed before recording their outcomes. Do not place identity documents in public media or notes.

Draft → submitted → approved / changes requested / rejected. Teacher profile or media changes increment the revision, hide the public profile, and require a new review. Admins cannot review their own profile. Stale profile/review submissions are rejected. **Existing teachers require review before their public listing is shown**; there is no silent grandfathered approval. Teaching/classroom access is unchanged by listing approval.

## Private evidence, content approval and updates

Experience includes private identity evidence and, when qualifications or education are claimed, supporting qualification evidence. PDF, PNG and JPEG uploads are validated and encrypted using a configured key. Owners and admin reviewers can download them through authenticated endpoints. Reviewers must download and inspect each document before recording its outcome; identity and applicable qualification evidence must be verified before approval. File retention removes source files while preserving the review outcome. Removing required evidence withdraws the listing and requires a new review.

Assessment content and review criteria start unapproved. Qualified reviewers sign off category and academic-level versions in the catalogue; edits invalidate that sign-off. Public catalogue responses expose only the approved version, keeping reviewer findings private. Applicable content approval is required before tutor submission and approval; Other subjects continue through manual review.

Submission and review decisions create in-app Updates and a queued status email. Delivery failures are retried across backend processes without exposing private evidence or reviewer findings in messages. See [setup and operations](tutor-onboarding-operations.md) for key configuration, retention, SMTP, readiness checks and backups, and [the pilot worksheet](tutor-onboarding-pilot.md) for the real-participant work still to perform. No production environment or real pilot is represented by the local tests.

## Deployment

FFmpeg supplies ffprobe; Poppler supplies pdfinfo for private document validation in the backend image. The default private storage path is `PROFILE_MEDIA_LOCAL_PATH/tutor-introductions`. Set `TUTOR_INTRO_VIDEO_LOCAL_PATH` to a private shared directory when using multiple API replicas. The multi-node Docker Compose configuration mounts one shared video volume on both nodes. The single-node production and Kubernetes paths use the existing profile media volume. Do not expose this directory as static files. Ensure the reverse proxy accepts multipart uploads above 50 MiB and persistent storage is backed up. No installer rebuild is needed for backend/admin changes; desktop packaging remains a separate operation.

Country-specific onboarding, safeguarding procedures, minors' guardian consent, retention, and other launch obligations need operational/legal implementation appropriate to each market. These UI review controls do not establish Europe-wide legal compliance.

## Verification

`tests/browser/tutor-onboarding-acceptance.spec.ts` runs headlessly against the real Nest backend, isolated MongoDB `whiteboard_acceptance`, Redis, and Angular UI. It covers catalogue counts/permissions/CRUD/stale versions/reseeding, rejected invalid inputs, upload/preview, draft privacy, teacher submission, review prerequisites, admin video playback and approval, public range playback, marketplace subject filtering, edit invalidation, link replacement, and mobile width. The extended flow also covers primary and university tasks in the same subject, admin overrides, inherited/default tasks, stale answers and review results, large subject/category selections, nested category cycles, wrong-category subjects, academic levels and teaching languages, matching within one teaching area, Other-only submission/review/public search, and admin level/language management. The extended checks also exercise private evidence uploads/downloads, ownership restrictions, ciphertext tamper detection, retention expiry, two API processes, expert content approvals, in-app status notices, email retries through a local SMTP server, and the readiness CLI. It uses synthetic evidence and video fixtures; no live account or real applicant is approved. Backend unit tests cover link validation and streaming. Teacher editor tests cover failed upload/preview recovery.

See [the local validation record](tutor-onboarding-validation.md) for the latest results and the distinction between synthetic acceptance and human launch checks.

## Student journey

Teacher profile class links retain both teacher and class IDs when opening Explore. Explore scopes results to that selection and offers Show all classes. The real-backend acceptance flow verifies an approved teacher can be found, a student can enroll in that teacher’s free class, unenrolled classroom access is denied, the student can join after the teacher starts the class, and teacher whiteboard updates reach the student. Classroom media is synthetic browser input through the real WebRTC/backend stack. This flow verifies enrollment; it does not exercise a payment checkout. Unspecified class levels are no longer assigned a hard-coded Intermediate label.
