'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Table, Td, Textarea, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface CourseRow {
  id: string;
  title: string;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  visibility: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';
  forcedOrder: boolean;
  itemCount: number;
  enrollmentCount: number;
  completedCount: number;
  updatedAt: string;
  coverImageUrl: string | null;
}

const STATUS_TONE = { DRAFT: 'yellow', PUBLISHED: 'green', ARCHIVED: 'gray' } as const;
const VISIBILITY_LABEL = { PRIVATE: 'Private (assigned / link)', ORGANIZATION: 'Organization', PUBLIC: 'Public link' } as const;

export default function CoursesPage() {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const { data, error, isLoading, mutate } = useSWR<{ data: CourseRow[] }>([wsPath('/courses'), { status: status || undefined, q: q || undefined }]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const c = await api<{ id: string }>(wsPath('/courses'), { method: 'POST', body: { title, description: description || null } });
      router.push(href(`/courses/${c.id}`));
    } catch (e) {
      toast.error(errorMessage(e));
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Courses"
        description="Sequence practice scenarios, videos, documents and links. Track each learner's progress."
        actions={can('courses.edit') && <Button onClick={() => setOpen(true)}>New course</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="w-64">
          <label className="sr-only" htmlFor="course-q">
            Search
          </label>
          <Input id="course-q" placeholder="Search courses…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="w-44">
          <label className="sr-only" htmlFor="course-status">
            Status
          </label>
          <Select id="course-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
          </Select>
        </div>
      </div>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data?.data.length ? (
        <EmptyState
          title="No courses yet"
          description="Create a course, add practice scenarios and content, then assign it to members or teams."
          action={can('courses.edit') && <Button onClick={() => setOpen(true)}>New course</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Course</Th>
              <Th>Status</Th>
              <Th>Visibility</Th>
              <Th className="text-right">Items</Th>
              <Th className="text-right">Learners</Th>
              <Th className="text-right">Completed</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <Td className="whitespace-normal">
                  <Link href={href(`/courses/${c.id}`)} className="font-medium text-brand-700 hover:underline">
                    {c.title}
                  </Link>
                  {c.forcedOrder && <span className="ml-2 text-xs text-slate-500">in order</span>}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[c.status]}>{c.status.toLowerCase()}</Badge>
                </Td>
                <Td className="text-xs">{VISIBILITY_LABEL[c.visibility]}</Td>
                <Td className="text-right tabular-nums">{c.itemCount}</Td>
                <Td className="text-right tabular-nums">{c.enrollmentCount}</Td>
                <Td className="text-right tabular-nums">{c.completedCount}</Td>
                <Td className="text-xs">{formatDate(c.updatedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New course"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={creating} disabled={!title.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Title" required>
            {(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />}
          </Field>
          <Field label="Description">{(id) => <Textarea id={id} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
      </Modal>
    </div>
  );
}
