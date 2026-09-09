import {handleRequest} from "../../../lib/newborn-api";
export const runtime="nodejs";export const dynamic="force-dynamic";const handler=request=>handleRequest(request);export {handler as GET,handler as POST,handler as PATCH,handler as DELETE};
