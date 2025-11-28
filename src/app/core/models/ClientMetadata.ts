/**
 * Represents the metadata for a client, including supported VP formats.
 */
export type ClientMetadata = {
  vp_formats: {
    [key: string]: SdJwtVcVpFormat | MsoMdocVpFormat;
  };
};

/**
 * Represents the format for SD-JWT VC/VP.
 */
export type SdJwtVcVpFormat = {
  'sd-jwt_alg_values': string[];
  'kb-jwt_alg_values': string[];
};

/**
 * Represents the format for MSO mdoc.
 */
export type MsoMdocVpFormat = {
  alg: string[];
};

/**
 * Fallback client metadata, providing default VP formats and algorithms.
 */
export const fallbackClientMetadata: ClientMetadata = {
  vp_formats: {
    'vc+sd-jwt': {
      'sd-jwt_alg_values': ['ES256', 'ML-DSA-44'],
      'kb-jwt_alg_values': ['ES256', 'ML-DSA-44'],
    },
    'dc+sd-jwt': {
      'sd-jwt_alg_values': ['ES256', 'ML-DSA-44'],
      'kb-jwt_alg_values': ['ES256', 'ML-DSA-44'],
    },
    mso_mdoc: {
      alg: ['ES256'],
    },
  },
};
