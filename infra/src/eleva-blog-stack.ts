/**
 * Compatibility shim.
 *
 * The stack used to be `ElevaBlogStack` in this file, back when the site was
 * only the blog API behind an ALB. It now fronts diegopalominos.dev with
 * S3 + CloudFront and lives in `./diego-site-stack`; this thin re-export
 * keeps any older reference (scripts, notes, a stale import) compiling.
 *
 * @deprecated Import `DiegoSiteStack` from `./diego-site-stack` instead.
 */
export {
  DiegoSiteStack as ElevaBlogStack,
  DiegoSiteStackProps as ElevaBlogStackProps,
} from './diego-site-stack';
