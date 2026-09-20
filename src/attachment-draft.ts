import {
  attachmentMediaType,
  attachmentSelectionError,
  type AttachmentUpload,
} from "../shared/attachments";

/** Keep browser File objects in the draft; encode only once a request is sent. */
export function validateAttachmentFiles(files: readonly File[]) {
  return attachmentSelectionError(files);
}

function encodeAttachment(file: File): Promise<AttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`无法读取「${file.name}」，请重新选择。`));
    reader.onabort = () => reject(new Error(`「${file.name}」读取已取消。`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error(`无法读取「${file.name}」，请重新选择。`));
        return;
      }
      resolve({
        name: file.name,
        mediaType: attachmentMediaType(file.name) ?? file.type,
        data: result.slice(result.indexOf(",") + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

export async function encodeAttachments(
  files: readonly File[],
): Promise<AttachmentUpload[]> {
  const error = validateAttachmentFiles(files);
  if (error) throw new Error(error);
  return Promise.all(files.map(encodeAttachment));
}
