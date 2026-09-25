import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { Errors } from './errors';

/** Usage: @Body(new ZodPipe(Schema)) body: z.infer<typeof Schema> */
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw Errors.validation(
        'Request validation failed',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }
}

export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return new ZodPipe(schema).transform(value);
}
