import { z } from 'zod';

const Signup = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  age: z.number().int().min(13),
  address: z.object({ zip: z.string().regex(/^\d{5}$/) }),
});

export function validateSignup(input) {
  const r = Signup.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) };
}
