import FileViewer from "@file-viewer/react-full";

export default function FlyfishAttachmentViewer({
  file,
  filename,
  contentType: _contentType,
  className = "flyfishViewer"
}: {
  file: File;
  filename: string;
  contentType: string;
  className?: string;
}) {
  const extension = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
  return (
    <FileViewer
      file={file}
      name={filename}
      filename={filename}
      type={extension}
      size={file.size}
      className={className}
      options={{
        theme: "light",
        styleIsolation: "shadow",
        toolbar: { position: "bottom-right" }
      }}
    />
  );
}
