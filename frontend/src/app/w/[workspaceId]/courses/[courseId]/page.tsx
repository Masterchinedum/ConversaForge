'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { CourseItemModal, type EditorItem } from '@/components/learning/CourseItemModal';
import { CourseLearners } from '@/components/learning/CourseLearners';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { KIND_LABEL, ruleLabel } from '@/lib/learning';
import { useWorkspace } from '@/lib/workspace';

interface CourseDetail {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  coverAssetId: string | null;
  coverImageUrl: string | null;
  forcedOrder: boolean;
  visibility: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  shareToken: string | null;
  shareUrl: string | null;
  items: EditorItem[];
  enrollmentCount: number;
}

type Tab = 'items' | 'details' | 'sharing' | 'learners';

export default function CourseEditorPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const coursePath = wsPath(`/courses/${courseId}`);
  const { data, error, isLoading, mutate } = useSWR<CourseDetail>(coursePath);
  const [tab, setTab] = useState<Tab>('items');
  const [itemModal, setItemModal] = useState<{ open: boolean; item: EditorItem | null }>({ open: false, item: null });
  const editable = can('courses.edit');

  const patch = async (body: Record<string, unknown>, ok = 'Saved') => {
    try {
      const d = await api<CourseDetail>(coursePath, { method: 'PATCH', body });
      await mutate(d, { revalidate: false });
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return null;

  const move = async (idx: number, dir: -1 | 1) => {
    const ids = data.items.map((i) => i.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    try {
      const d = await api<CourseDetail>(`${coursePath}/items/order`, { method: 'PUT', body: { itemIds: ids } });
      await mutate(d, { revalidate: false });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        back={{ href: href('/courses'), label: 'Courses' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {data.title}
            <Badge tone={data.status === 'PUBLISHED' ? 'green' : data.status === 'DRAFT' ? 'yellow' : 'gray'}>{data.status.toLowerCase()}</Badge>
          </span>
        }
        description={`${data.items.length} item(s) · ${data.enrollmentCount} learner(s)${data.forcedOrder ? ' · must be taken in order' : ''}`}
        actions={
          <>
            <ButtonLink variant="secondary" href={href(`/learn/courses/${data.id}`)}>
              Preview as learner
            </ButtonLink>
            {editable && data.status !== 'PUBLISHED' && (
              <Button onClick={() => patch({ status: 'PUBLISHED' }, 'Course published')} disabled={!data.items.length}>
                Publish
              </Button>
            )}
            {editable && data.status === 'PUBLISHED' && (
              <ConfirmButton variant="secondary" confirmText="Move the course back to draft? Learners will not see it until it is published again." onConfirm={() => void patch({ status: 'DRAFT' }, 'Unpublished')}>
                Unpublish
              </ConfirmButton>
            )}
          </>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'items', label: `Items (${data.items.length})` },
          { id: 'details', label: 'Details' },
          { id: 'sharing', label: 'Access & sharing' },
          { id: 'learners', label: `Learners (${data.enrollmentCount})` },
        ]}
      />

      {tab === 'items' && (
        <div className="space-y-3">
          {data.items.length === 0 ? (
            <EmptyState
              title="No items yet"
              description="Add practice scenarios, videos, documents or links."
              action={editable && <Button onClick={() => setItemModal({ open: true, item: null })}>Add item</Button>}
            />
          ) : (
            <ol className="space-y-2">
              {data.items.map((item, idx) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      {idx + 1}. {KIND_LABEL[item.kind]} · {ruleLabel(item.completionRule)} · {item.required ? 'required' : 'optional'}
                    </p>
                    <p className="font-medium text-slate-900">{item.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      {item.kind === 'SCENARIO'
                        ? `${item.scenario?.name ?? 'Missing scenario'} · ${item.pinnedVersion ? `pinned v${item.pinnedVersion.version}` : 'latest version'}`
                        : item.asset
                          ? `Uploaded: ${item.asset.fileName}`
                          : item.url}
                    </p>
                    {item.kind === 'SCENARIO' && item.scenario && !item.scenario.runnable && (
                      <p className="text-xs text-red-700">This scenario is archived or unpublished — learners cannot start it.</p>
                    )}
                  </div>
                  {editable && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" aria-label="Move up" disabled={idx === 0} onClick={() => move(idx, -1)}>
                        ↑
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Move down" disabled={idx === data.items.length - 1} onClick={() => move(idx, 1)}>
                        ↓
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setItemModal({ open: true, item })}>
                        Edit
                      </Button>
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        confirmText="Remove this item? Learner attempts for it are deleted."
                        onConfirm={async () => {
                          try {
                            await api(`${coursePath}/items/${item.id}`, { method: 'DELETE' });
                            await mutate();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        Remove
                      </ConfirmButton>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {editable && data.items.length > 0 && <Button onClick={() => setItemModal({ open: true, item: null })}>Add item</Button>}
          <CourseItemModal
            open={itemModal.open}
            item={itemModal.item}
            coursePath={coursePath}
            onClose={() => setItemModal({ open: false, item: null })}
            onSaved={() => mutate()}
          />
        </div>
      )}

      {tab === 'details' && <DetailsTab course={data} coursePath={coursePath} editable={editable} onPatch={patch} onChanged={() => mutate()} onDeleted={() => router.push(href('/courses'))} />}

      {tab === 'sharing' && <SharingTab course={data} coursePath={coursePath} canShare={can('courses.assign')} editable={editable} onPatch={patch} onChanged={(d) => mutate(d as any)} />}

      {tab === 'learners' && <CourseLearners coursePath={coursePath} published={data.status === 'PUBLISHED'} shareUrl={data.shareUrl} />}
    </div>
  );
}

function DetailsTab({
  course,
  coursePath,
  editable,
  onPatch,
  onChanged,
  onDeleted,
}: {
  course: CourseDetail;
  coursePath: string;
  editable: boolean;
  onPatch: (b: Record<string, unknown>, ok?: string) => Promise<boolean>;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description ?? '');
  const [coverUrl, setCoverUrl] = useState(course.coverUrl ?? '');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTitle(course.title);
    setDescription(course.description ?? '');
    setCoverUrl(course.coverUrl ?? '');
  }, [course.title, course.description, course.coverUrl]);

  const uploadCover = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api(`${coursePath}/assets`, { method: 'POST', body: fd, query: { purpose: 'cover' } });
      onChanged();
      toast.success('Cover updated');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Details" className="lg:col-span-2">
        <div className="space-y-4">
          <Field label="Title" required>
            {(id) => <Input id={id} value={title} maxLength={200} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label="Description">{(id) => <Textarea id={id} rows={5} maxLength={5000} disabled={!editable} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Checkbox
            label="Learners must complete items in order"
            description="Items unlock once all earlier required items are complete."
            checked={course.forcedOrder}
            disabled={!editable}
            onChange={(v) => void onPatch({ forcedOrder: v })}
          />
          {editable && (
            <Button onClick={() => onPatch({ title: title.trim(), description: description.trim() || null })} disabled={!title.trim() || (title === course.title && description === (course.description ?? ''))}>
              Save details
            </Button>
          )}
        </div>
      </Card>
      <Card title="Cover image">
        <div className="space-y-3">
          {course.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={course.coverImageUrl} alt="Course cover" className="h-32 w-full rounded object-cover" />
          ) : (
            <div className="flex h-32 items-center justify-center rounded bg-slate-100 text-xs text-slate-500">No cover</div>
          )}
          {editable && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                aria-label="Upload cover image"
                className="text-sm"
                onChange={(e) => e.target.files?.[0] && uploadCover(e.target.files[0])}
              />
              {uploading && <p className="text-xs text-slate-500">Uploading…</p>}
              <Field label="…or image URL" hint="https:// only">
                {(id) => <Input id={id} type="url" value={coverUrl} placeholder="https://…" onChange={(e) => setCoverUrl(e.target.value)} />}
              </Field>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={!/^https:\/\//.test(coverUrl) || coverUrl === course.coverUrl} onClick={() => onPatch({ coverUrl }, 'Cover updated')}>
                  Use URL
                </Button>
                {(course.coverAssetId || course.coverUrl) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api(`${coursePath}/cover`, { method: 'DELETE' });
                        onChanged();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Remove cover
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Card>
      {editable && (
        <Card title="Danger zone" className="lg:col-span-3">
          <div className="flex flex-wrap gap-2">
            {course.status !== 'ARCHIVED' ? (
              <ConfirmButton variant="secondary" confirmText="Archive this course? Enrolled learners keep read-only access to their history." onConfirm={() => void onPatch({ status: 'ARCHIVED' }, 'Archived')}>
                Archive course
              </ConfirmButton>
            ) : (
              <Button variant="secondary" onClick={() => onPatch({ status: 'DRAFT' }, 'Restored as draft')}>
                Restore as draft
              </Button>
            )}
            <ConfirmButton
              variant="danger"
              confirmText="Delete this course for everyone? This cannot be undone."
              onConfirm={async () => {
                try {
                  await api(coursePath, { method: 'DELETE' });
                  onDeleted();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Delete course
            </ConfirmButton>
          </div>
        </Card>
      )}
    </div>
  );
}

function SharingTab({
  course,
  coursePath,
  canShare,
  editable,
  onPatch,
  onChanged,
}: {
  course: CourseDetail;
  coursePath: string;
  canShare: boolean;
  editable: boolean;
  onPatch: (b: Record<string, unknown>, ok?: string) => Promise<boolean>;
  onChanged: (d: unknown) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const token = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    try {
      await api(`${coursePath}/share-token`, { method });
      onChanged(undefined);
      toast.success(method === 'POST' ? (course.shareToken ? 'New link created — the old link no longer works' : 'Link created') : 'Link revoked');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Who can find this course">
        <div className="space-y-3">
          <Field label="Visibility">
            {(id) => (
              <Select id={id} value={course.visibility} disabled={!editable} onChange={(e) => void onPatch({ visibility: e.target.value }, 'Visibility updated')}>
                <option value="PRIVATE">Private — only assigned learners (and course link holders)</option>
                <option value="ORGANIZATION">Organization — any member can enroll</option>
                <option value="PUBLIC">Public — members can enroll; anyone signed in can join with the link</option>
              </Select>
            )}
          </Field>
          <p className="text-xs text-slate-500">Learners only see published courses. Progress always starts at 0% for a new enrollment.</p>
        </div>
      </Card>
      <Card title="Course link">
        <div className="space-y-3">
          {course.shareUrl ? (
            <>
              <div className="flex gap-2">
                <Input readOnly value={course.shareUrl} aria-label="Course link" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton value={course.shareUrl} />
              </div>
              <p className="text-xs text-slate-500">Anyone who signs in with this link can enroll. Rotating or revoking stops the current link immediately.</p>
              {course.status !== 'PUBLISHED' && <Alert tone="warning">The link works once the course is published.</Alert>}
              {canShare && (
                <div className="flex gap-2">
                  <ConfirmButton variant="secondary" size="sm" disabled={busy} confirmText="Create a new link? The current link will stop working." onConfirm={() => token('POST')}>
                    Rotate link
                  </ConfirmButton>
                  <ConfirmButton variant="ghost" size="sm" disabled={busy} confirmText="Revoke the link? People who have not enrolled yet can no longer join with it." onConfirm={() => token('DELETE')}>
                    Revoke
                  </ConfirmButton>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">Create a link to let people enroll themselves — including people without an account yet (they sign up first).</p>
              {canShare && (
                <Button onClick={() => token('POST')} loading={busy}>
                  Create course link
                </Button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
