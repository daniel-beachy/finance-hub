/** The thing asked for doesn't exist. The API answers 404. */
export class NotFound extends Error {}
/** The request itself is wrong. The API answers 400. */
export class InvalidInput extends Error {}
