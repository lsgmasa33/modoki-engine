/** Reading a dropped/picked browser `File` as bytes the backend can accept.
 *
 *  ONE definition, shared by the Assets panel's OS-file import and the Project Settings path
 *  field's drop (#408 follow-up): both POST base64 to a backend route that writes it to disk, and
 *  a second copy of the "strip the data: prefix" step is a silent corruption waiting to happen —
 *  the prefix is only present for some readers and the failure is a file that writes successfully
 *  and is not the file you dropped. */

/** Read a browser File as base64 with NO `data:<mime>;base64,` prefix — the shape
 *  `POST /api/write-file` and `POST /api/adopt-file` expect for `encoding: 'base64'`. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:<mime>;base64,XXXX"
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
