import { z } from 'zod';

const Signup = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  age: z.number().int().min(13),
  address: z.object({ zip: z.string().regex(/^\d{5}$/) }),
});

export function validateSignup(input) {
  const value = Signup.parse(input);
  return { ok: true, value };
}
