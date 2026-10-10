// Structured errors shared by every module. A SummitError carries a stable code, a message, the
// function that raised it and the inputs that function received.

export const ERROR_CODES = [
    'SUMMIT_NOT_JOINED',
    'SUMMIT_UNKNOWN_TARGET',
    'SUMMIT_TARGET_GONE',
    'SUMMIT_SELF_SEND',
    'SUMMIT_NAME_TAKEN',
    'SUMMIT_NO_HOST_KEY',
    'SUMMIT_BAD_INPUT',
    'SUMMIT_BAD_GROUP',
    'SUMMIT_BAD_NAME',
    'SUMMIT_LOCK_TIMEOUT',
    'SUMMIT_CORRUPT_FILE',
    'SUMMIT_IO',
    'SUMMIT_EXEC_FAILED',
    'SUMMIT_INSTALL_CONFLICT',
    'SUMMIT_INTERNAL',
] as const

export type SummitErrorCode = (typeof ERROR_CODES)[number]

export interface SummitErrorShape {
    code: SummitErrorCode
    message: string
    fn: string
    inputs: Record<string, unknown>
}

export class SummitError extends Error {
    readonly code: SummitErrorCode
    readonly fn: string
    readonly inputs: Record<string, unknown>

    constructor(shape: SummitErrorShape, options?: { cause?: unknown }) {
        super(shape.message, options)
        this.name = 'SummitError'
        this.code = shape.code
        this.fn = shape.fn
        this.inputs = shape.inputs
    }

    // Purpose: give a plain object for logs and tool results.
    toJSON(): SummitErrorShape {
        return { code: this.code, message: this.message, fn: this.fn, inputs: this.inputs }
    }
}

// Purpose: build a SummitError in one expression.
export function summitError(
    code: SummitErrorCode,
    message: string,
    fn: string,
    inputs: Record<string, unknown> = {},
    cause?: unknown,
): SummitError {
    return new SummitError({ code, message, fn, inputs }, cause === undefined ? undefined : { cause })
}

// Purpose: turn any thrown value into a SummitError, keeping SummitErrors as they are.
export function toSummitError(err: unknown, fn: string, inputs: Record<string, unknown> = {}): SummitError {
    if (err instanceof SummitError) return err
    const message = err instanceof Error ? err.message : String(err)
    return summitError('SUMMIT_INTERNAL', message, fn, inputs, err)
}

// Purpose: tell whether a Node fs error has a given errno code (ENOENT, EEXIST, ...).
export function hasErrno(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}
