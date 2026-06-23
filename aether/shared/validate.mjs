// Minimal boundary validation. Throws ValidationError (HTTP 400) with a clear
// message. Zero deps; enough to reject malformed/oversized/unauthorized-shape
// input before it reaches business logic.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function str(obj, field, { min = 1, max = 512, required = true } = {}) {
  const v = obj?.[field];
  if (v == null || v === "") {
    if (required) throw new ValidationError(`'${field}' is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ValidationError(`'${field}' must be a string`);
  if (v.length < min) throw new ValidationError(`'${field}' must be >= ${min} chars`);
  if (v.length > max) throw new ValidationError(`'${field}' must be <= ${max} chars`);
  return v;
}

export function email(obj, field = "email", opts = {}) {
  const v = str(obj, field, { max: 254, ...opts });
  if (v !== undefined && !EMAIL_RE.test(v)) {
    throw new ValidationError(`'${field}' is not a valid email`);
  }
  return v;
}

export function oneOf(obj, field, allowed, { required = true } = {}) {
  const v = obj?.[field];
  if (v == null || v === "") {
    if (required) throw new ValidationError(`'${field}' is required`);
    return undefined;
  }
  if (!allowed.includes(v)) {
    throw new ValidationError(`'${field}' must be one of: ${allowed.join(", ")}`);
  }
  return v;
}

export function object(obj, field, { required = true } = {}) {
  const v = obj?.[field];
  if (v == null) {
    if (required) throw new ValidationError(`'${field}' is required`);
    return undefined;
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(`'${field}' must be an object`);
  }
  return v;
}
