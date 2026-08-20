import { useEffect, useRef, useState } from 'react'

/**
 * The mail bridge setup, start to finish, in the app rather than in a doc
 * nobody opens. Every expression and schema here is long and unforgiving, so
 * each one gets a copy button — retyping them by hand is how the setup goes
 * wrong.
 */

function Snippet({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="guide-snippet">
      <code>{text}</code>
      <button className="btn btn-ghost guide-copy" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  )
}

const PARSE_SCHEMA = `{"type":"object","properties":{"kind":{"type":"string"},"messageId":{"type":"string"},"conversationId":{"type":["string","null"]},"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"},"bodyHtml":{"type":"string"},"queuedAt":{"type":"string"}},"required":["kind","messageId","to","subject","body"]}`

const PATCH_BODY = `{"body":{"contentType":"HTML","content":"@{concat('<div>', coalesce(body('Parse_JSON')?['bodyHtml'], body('Parse_JSON')?['body']), '</div><br>', body('Create_reply')?['body']?['content'])}"}}`

export function MailGuideDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className="confirm mail-guide"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <h3>Setting up mail</h3>

      <div className="guide-scroll">
        <p className="guide-intro">
          Rowan can&rsquo;t read Exchange directly. Rowan University requires an administrator
          to approve any app that touches mail, and that approval isn&rsquo;t something you can
          grant yourself. So mail comes the long way round: a Power Automate flow files each
          message into OneDrive, OneDrive syncs it to this PC, and Rowan reads the folder. No
          password, no tokens, nothing to approve. A second flow carries replies back the
          other way, landing them in Outlook as drafts inside the thread they answer.
        </p>

        <section className="guide-step">
          <h4>1. Get your Rowan OneDrive onto this PC</h4>
          <p>
            System tray → the OneDrive cloud icon → gear → <strong>Settings</strong> →{' '}
            <strong>Account</strong> → <strong>Add an account</strong>, and sign in with your
            Rowan address. A personal OneDrive can stay signed in alongside it; they get
            separate folders.
          </p>
          <p>
            Then find <code>OneDrive - Rowan University\Apps</code> in File Explorer,
            right-click it, and choose <strong>Always keep on this device</strong>. Without
            that, Windows leaves the files as cloud-only placeholders and Rowan sees an empty
            folder.
          </p>
        </section>

        <section className="guide-step">
          <h4>2. The inbox flow</h4>
          <p>
            At <code>make.powerautomate.com</code>: <strong>Create</strong> →{' '}
            <strong>Automated cloud flow</strong>, name it <em>Rowan inbox bridge</em>, and
            pick the trigger <strong>When a new email arrives (V3)</strong>.
          </p>
          <p>On the trigger, set Folder to Inbox and both attachment options to No.</p>
          <p>
            Add <strong>OneDrive for Business → Create file</strong>, with Folder Path{' '}
            <code>/Apps/Rowan/in</code>. For File Name and File Content, switch each box to
            the expression tab (the <em>fx</em> button) and paste:
          </p>
          <Snippet text="concat(utcNow('yyyyMMddHHmmssfff'), '-', guid(), '.json')" />
          <Snippet text="string(triggerOutputs()?['body'])" />
          <p className="guide-why">
            Writing the whole message object means nothing breaks on a subject line
            containing a quote, and Rowan gets every field the connector exposes, including
            the sender&rsquo;s real name.
          </p>
        </section>

        <section className="guide-step">
          <h4>3. The drafts flow</h4>
          <p>
            A second automated flow, <em>Rowan draft bridge</em>, trigger{' '}
            <strong>When a file is created</strong> (OneDrive for Business), Folder{' '}
            <code>/Apps/Rowan/out</code>. Then four actions:
          </p>
          <p>
            <strong>Get file content</strong> — File: the trigger&rsquo;s <code>Identifier</code>.
          </p>
          <p>
            <strong>Parse JSON</strong> — Content must be an expression, not the dynamic
            token, because the connector hands back binary whatever the file extension says:
          </p>
          <Snippet text="json(base64ToString(body('Get_file_content')?['$content']))" />
          <p>And the Schema box:</p>
          <Snippet text={PARSE_SCHEMA} />
          <p className="guide-why">
            Paste that rather than using &ldquo;generate from sample&rdquo;. A sample makes
            Power Automate guess that every field is always present, and the flow then fails
            on any draft where one isn&rsquo;t.
          </p>
          <p>
            <strong>Create reply</strong> — connector{' '}
            <strong>HTTP with Microsoft Entra ID (preauthorized)</strong>, action{' '}
            <em>Invoke an HTTP request</em>. The first time, it asks for a connection: put{' '}
            <code>https://graph.microsoft.com</code> in <em>both</em> the Entra ID Resource
            URI and the Base Resource URL boxes, then sign in as yourself. Method{' '}
            <strong>POST</strong>, no headers, no body, and the URL on the expression tab:
          </p>
          <Snippet text="concat('https://graph.microsoft.com/v1.0/me/messages/', encodeUriComponent(body('Parse_JSON')?['messageId']), '/createReply')" />
          <p className="guide-why">
            Rename this action to exactly <em>Create reply</em>. The next step calls it by
            name, and Power Automate turns the space into an underscore behind the scenes.
          </p>
          <p>
            <strong>Fill reply</strong> — a second <em>Invoke an HTTP request</em>. Method{' '}
            <strong>PATCH</strong>, one header (<code>Content-Type</code> /{' '}
            <code>application/json</code>), and this URL:
          </p>
          <Snippet text="concat('https://graph.microsoft.com/v1.0/me/messages/', encodeUriComponent(body('Create_reply')?['id']))" />
          <p>And in the Body box:</p>
          <Snippet text={PATCH_BODY} />
          <p className="guide-why">
            <code>createReply</code> makes an empty draft that is already inside the
            conversation, already addressed, with the original quoted underneath. The PATCH
            drops your reply in above it. The Outlook connector cannot do this — its draft
            action builds a brand new message, which is why replies used to land detached
            from the thread they answered.
          </p>
          <p>
            <strong>Delete file</strong> — the trigger&rsquo;s <code>Identifier</code> again.
            Skip this and the folder fills up and every rerun makes a duplicate draft.
          </p>
          <p className="guide-why">
            Power Automate marks this connector premium, and the flow checker will warn that
            the owner needs a Premium license. The flow still saved and ran without one when
            this was set up. If that ever changes, the fallback is the Copy button on a draft:
            paste it into a reply you start in Outlook yourself.
          </p>
        </section>

        <section className="guide-step">
          <h4>4. Point Rowan at the folder</h4>
          <p>
            Back in Settings → Mail → <strong>Choose mail folder</strong>, and pick{' '}
            <code>OneDrive - Rowan University\Apps\Rowan</code> — the folder that{' '}
            <em>contains</em> <code>in</code>, not <code>in</code> itself.
          </p>
          <p>Send yourself a test email. It should appear on the Mail page within a minute.</p>
        </section>

        <section className="guide-step">
          <h4>5. Your signature</h4>
          <p>
            Outlook only puts a signature on a message you compose yourself, so a draft the
            flow creates arrives without one. Rowan carries its own copy instead.
          </p>
          <p>
            Open a new message in Outlook, select the signature, copy it, and paste it into
            the <strong>Signature</strong> box under Settings → Mail. The formatting comes
            across with it — the clipboard carries Outlook&rsquo;s own HTML alongside the
            plain text.
          </p>
          <p className="guide-why">
            Images are dropped on purpose. A pasted logo arrives as a reference to a
            temporary file on this PC, which resolves to nothing by the time the draft
            reaches Outlook, so the choice was a broken image or none. Everything else —
            fonts, colours, sizes, links — survives.
          </p>
          <p>
            Worth reading what lands in the box rather than trusting it. Signatures get
            copied between colleagues and quietly keep the wrong address behind the link.
          </p>
        </section>

        <section className="guide-step">
          <h4>When something goes wrong</h4>
          <p>
            Every flow keeps 28 days of run history, and a failed run shows exactly which
            action broke and what it received. Start there.
          </p>
          <ul className="guide-list-plain">
            <li>
              <strong>Nothing arrives in Rowan</strong> — check the folder in File Explorer.
              Files there but not in Rowan usually means the folder is set to cloud-only;
              redo the &ldquo;Always keep on this device&rdquo; step.
            </li>
            <li>
              <strong>&ldquo;must be of type JSON … was of type application/octet-stream&rdquo;</strong> —
              Parse JSON is reading the raw dynamic token. Use the{' '}
              <code>base64ToString</code> expression above.
            </li>
            <li>
              <strong>&ldquo;schema validation failed&rdquo;</strong> — a field the schema
              demands is missing, usually because the file was written by an older version of
              Rowan. Re-copy the schema above, which only requires the fields that are always
              present.
            </li>
            <li>
              <strong>404 from Create reply</strong> — Exchange changes a message&rsquo;s id
              when it moves between folders, so a reply drafted long after the mail was
              filed away can point at an id that no longer exists. Answering from the Mail
              page while the message is still in the Inbox avoids it.
            </li>
            <li>
              <strong>The reply is empty, or the quoted history is missing</strong> — the
              PATCH is naming the previous action wrongly. It has to be{' '}
              <code>Create_reply</code>, underscore and all, matching whatever the action is
              actually called.
            </li>
          </ul>
        </section>
      </div>

      <div className="confirm-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  )
}
