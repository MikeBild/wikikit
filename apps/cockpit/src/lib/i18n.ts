export const LOCALES = ['en', 'de'] as const
export type Locale = (typeof LOCALES)[number]

export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-US',
  de: 'de-DE',
}

const EN = {
  'app.name': 'WikiKit',
  'nav.label': 'Cockpit navigation',
  'nav.home': 'Home',
  'nav.pages': 'Pages',
  'nav.changes': 'Changes',
  'nav.sources': 'Sources',
  'nav.decisions': 'Decisions',
  'nav.search': 'Search',
  'nav.charter': 'Charter',
  'nav.spaces': 'Wikis',
  'nav.apiKeys': 'API keys',
  'nav.identities': 'People',
  'nav.webhooks': 'Webhooks',
  'nav.system': 'System',
  'nav.group.home': 'Home',
  'nav.group.wiki': 'Wiki',
  'nav.group.installation': 'Installation',
  'space.fallback': 'Wiki',
  'space.choose': 'Choose a wiki',
  'account.menu': 'User menu',
  'account.profile': 'Profile',
  'account.signInType': 'Sign-in type',
  'account.apiKey': 'API key',
  'account.identity': 'Identity provider',
  'account.permissions': 'Permissions',
  'account.language': 'Language',
  'account.language.auto': 'Automatic',
  'account.language.en': 'English',
  'account.language.de': 'German',
  'account.theme': 'Theme',
  'account.theme.system': 'Match system',
  'account.theme.light': 'Light',
  'account.theme.dark': 'Dark',
  'account.signOut': 'Sign out',
  'account.signingOut': 'Signing out…',
  'account.signOutFailed': 'Could not sign out',
  'common.loading': 'Loading',
  'common.actions': 'Actions',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.tryAgain': 'Try again',
  'common.refresh': 'Refresh',
  'common.save': 'Save',
  'common.create': 'Create',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.none': 'None',
  'common.unknown': 'Unknown',
  'common.internalReferenceHidden': 'Internal reference hidden',
  'common.unnamedIdentity': 'Unnamed identity',
  'table.columns': 'Columns',
  'table.hidden': '{count} hidden',
  'table.always': 'always',
  'table.reset': 'Reset columns',
  'table.empty': 'Nothing here yet.',
  'table.sorted.server': 'Sorted by {label} — the server orders this list.',
  'table.sorted.capped': 'Sorted by {label} across all {count} {unit} loaded — the list may hold more.',
  'table.sorted.all': 'Sorted by {label} across all {count} {unit}, not just this page.',
  'table.capped': 'only {count} {unit} are loaded — there may be more',
  'pagination.label': 'Pagination',
  'pagination.page': 'Page {page} · {shown} {unit}',
  'pagination.showing': 'Showing {start}–{end} of {total} {unit}',
  'pagination.end': 'end of the list',
  'pagination.loading': 'loading…',
  'pagination.previous': 'Previous',
  'pagination.next': 'Next',
  'page.home.description': 'The current state of this wiki at a glance.',
  'page.pages.description': 'Published knowledge, its history and proposed edits.',
  'page.changes.description': 'Review proposed changes before they become published knowledge.',
  'page.sources.description': 'Documents and streams that provide evidence for this wiki.',
  'page.decisions.description': 'Recorded decisions and the evidence behind them.',
  'page.search.description': 'Find knowledge and ask questions across this wiki.',
  'page.charter.description': 'The rules that define what belongs in this wiki.',
  'page.spaces.description': 'Available wikis and their operational settings.',
  'page.apiKeys.description': 'Machine credentials and their effective permissions.',
  'page.identities.description': 'People who can sign in and their permission ceilings.',
  'page.webhooks.description': 'Destinations that receive WikiKit events.',
  'page.system.description': 'Installation health, knowledge quality and activity.',
  'system.tab.overview': 'Overview',
  'system.tab.knowledge': 'Knowledge',
  'system.tab.activity': 'Activity',
  'session.checking': 'Checking your session…',
  'session.unreachable': 'Could not reach WikiKit',
  'session.noAnswer': 'The session endpoint did not answer.',
  'session.signIn.title': 'Sign in to WikiKit',
  'session.signIn.description': 'Continue on the WikiKit sign-in page.',
  'session.signIn.action': 'Sign in',
} as const

export type TranslationKey = keyof typeof EN

const DE: Record<TranslationKey, string> = {
  'app.name': 'WikiKit',
  'nav.label': 'Cockpit-Navigation',
  'nav.home': 'Start',
  'nav.pages': 'Seiten',
  'nav.changes': 'Änderungen',
  'nav.sources': 'Quellen',
  'nav.decisions': 'Entscheidungen',
  'nav.search': 'Suche',
  'nav.charter': 'Leitlinien',
  'nav.spaces': 'Wikis',
  'nav.apiKeys': 'API-Schlüssel',
  'nav.identities': 'Personen',
  'nav.webhooks': 'Webhooks',
  'nav.system': 'System',
  'nav.group.home': 'Start',
  'nav.group.wiki': 'Wiki',
  'nav.group.installation': 'Installation',
  'space.fallback': 'Wiki',
  'space.choose': 'Wiki auswählen',
  'account.menu': 'Benutzermenü',
  'account.profile': 'Profil',
  'account.signInType': 'Anmeldeart',
  'account.apiKey': 'API-Schlüssel',
  'account.identity': 'Identitätsanbieter',
  'account.permissions': 'Berechtigungen',
  'account.language': 'Sprache',
  'account.language.auto': 'Automatisch',
  'account.language.en': 'Englisch',
  'account.language.de': 'Deutsch',
  'account.theme': 'Darstellung',
  'account.theme.system': 'Systemeinstellung',
  'account.theme.light': 'Hell',
  'account.theme.dark': 'Dunkel',
  'account.signOut': 'Abmelden',
  'account.signingOut': 'Wird abgemeldet…',
  'account.signOutFailed': 'Abmeldung fehlgeschlagen',
  'common.loading': 'Wird geladen',
  'common.actions': 'Aktionen',
  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'common.confirm': 'Bestätigen',
  'common.copy': 'Kopieren',
  'common.copied': 'Kopiert',
  'common.tryAgain': 'Erneut versuchen',
  'common.refresh': 'Aktualisieren',
  'common.save': 'Speichern',
  'common.create': 'Erstellen',
  'common.edit': 'Bearbeiten',
  'common.delete': 'Löschen',
  'common.none': 'Keine',
  'common.unknown': 'Unbekannt',
  'common.internalReferenceHidden': 'Interne Referenz ausgeblendet',
  'common.unnamedIdentity': 'Unbenannte Identität',
  'table.columns': 'Spalten',
  'table.hidden': '{count} ausgeblendet',
  'table.always': 'immer',
  'table.reset': 'Spalten zurücksetzen',
  'table.empty': 'Noch keine Einträge.',
  'table.sorted.server': 'Nach {label} sortiert — der Server ordnet diese Liste.',
  'table.sorted.capped': 'Nach {label} über {count} geladene {unit} sortiert — weitere können vorhanden sein.',
  'table.sorted.all': 'Nach {label} über alle {count} {unit} sortiert, nicht nur über diese Seite.',
  'table.capped': 'Nur {count} {unit} sind geladen — weitere können vorhanden sein',
  'pagination.label': 'Seitennavigation',
  'pagination.page': 'Seite {page} · {shown} {unit}',
  'pagination.showing': '{start}–{end} von {total} {unit}',
  'pagination.end': 'Ende der Liste',
  'pagination.loading': 'wird geladen…',
  'pagination.previous': 'Zurück',
  'pagination.next': 'Weiter',
  'page.home.description': 'Der aktuelle Zustand dieses Wikis auf einen Blick.',
  'page.pages.description': 'Veröffentlichtes Wissen, sein Verlauf und vorgeschlagene Änderungen.',
  'page.changes.description': 'Vorgeschlagene Änderungen prüfen, bevor sie veröffentlicht werden.',
  'page.sources.description': 'Dokumente und Datenströme, die Nachweise für dieses Wiki liefern.',
  'page.decisions.description': 'Dokumentierte Entscheidungen und die zugehörigen Nachweise.',
  'page.search.description': 'Wissen in diesem Wiki finden und Fragen dazu stellen.',
  'page.charter.description': 'Die Regeln dafür, was in dieses Wiki gehört.',
  'page.spaces.description': 'Verfügbare Wikis und ihre betrieblichen Einstellungen.',
  'page.apiKeys.description': 'Maschinenzugänge und ihre wirksamen Berechtigungen.',
  'page.identities.description': 'Personen mit Zugang und ihre Berechtigungsgrenzen.',
  'page.webhooks.description': 'Ziele, die WikiKit-Ereignisse empfangen.',
  'page.system.description': 'Installationszustand, Wissensqualität und Aktivität.',
  'system.tab.overview': 'Übersicht',
  'system.tab.knowledge': 'Wissen',
  'system.tab.activity': 'Aktivität',
  'session.checking': 'Sitzung wird geprüft…',
  'session.unreachable': 'WikiKit ist nicht erreichbar',
  'session.noAnswer': 'Der Sitzungsendpunkt hat nicht geantwortet.',
  'session.signIn.title': 'Bei WikiKit anmelden',
  'session.signIn.description': 'Auf der WikiKit-Anmeldeseite fortfahren.',
  'session.signIn.action': 'Anmelden',
}

export const CATALOGS: Record<Locale, Readonly<Record<TranslationKey, string>>> = { en: EN, de: DE }

/**
 * Product language whose English wording is already the source-level contract.
 *
 * Navigation and shared chrome use stable keys above. Domain surfaces have a
 * much larger vocabulary and many of their English sentences are asserted by
 * behavioural tests. Keeping that source wording as the lookup key lets those
 * tests keep guarding the product promise while the renderer supplies the
 * selected language. Only exact, reviewed phrases are translated: titles and
 * user/server content never pass through a machine translator.
 */
export const DE_PHRASES = {
  Actions: 'Aktionen',
  Edit: 'Bearbeiten',
  Waiting: 'Wartet',
  'Knowledge change': 'Wissensänderung',
  'Page update': 'Seitenaktualisierung',
  'Defer this page?': 'Diese Seite zurückstellen?',
  Active: 'Aktiv',
  Address: 'Adresse',
  Admitted: 'Zugelassen',
  All: 'Alle',
  'Any time': 'Beliebiger Zeitraum',
  'Last 7 days': 'Letzte 7 Tage',
  'Last 30 days': 'Letzte 30 Tage',
  'Last 90 days': 'Letzte 90 Tage',
  Approved: 'Freigegeben',
  Archived: 'Archiviert',
  Attempts: 'Versuche',
  Change: 'Änderung',
  Changed: 'Geändert',
  Claims: 'Aussagen',
  Condition: 'Bedingung',
  Context: 'Kontext',
  Decision: 'Entscheidung',
  Decisions: 'Entscheidungen',
  Decided: 'Entschieden',
  'Decided through': 'Entschieden über',
  Document: 'Dokument',
  Endpoint: 'Endpunkt',
  Event: 'Ereignis',
  Everything: 'Alles',
  Evidence: 'Nachweise',
  Failed: 'Fehlgeschlagen',
  'Failures in a row': 'Fehler in Folge',
  German: 'Deutsch',
  Granted: 'Vergeben',
  'Granted by': 'Vergeben von',
  History: 'Verlauf',
  'In force': 'Gültig',
  Key: 'Schlüssel',
  Kind: 'Art',
  'Last change': 'Letzte Änderung',
  'Last seen': 'Zuletzt gesehen',
  'Last used': 'Zuletzt verwendet',
  Live: 'Aktiv',
  Loading: 'Wird geladen',
  'May do': 'Darf',
  Minted: 'Erstellt',
  'Next attempt': 'Nächster Versuch',
  Page: 'Seite',
  Pages: 'Seiten',
  Person: 'Person',
  Preview: 'Vorschau',
  Purpose: 'Zweck',
  Queued: 'Eingereiht',
  Raised: 'Eingereicht',
  'Reads from': 'Liest aus',
  Reaches: 'Gültigkeit',
  Recorded: 'Erfasst',
  Registered: 'Registriert',
  Rendered: 'Gerendert',
  Retrieval: 'Sucheinstellung',
  Revision: 'Revision',
  Revoked: 'Widerrufen',
  Reviewer: 'Prüfende Person',
  Scopes: 'Berechtigungen',
  Slug: 'Slug',
  Source: 'Quelle',
  Sources: 'Quellen',
  'Signs in with': 'Anmeldung über',
  'Split from': 'Abgetrennt von',
  Status: 'Status',
  Subscribed: 'Abonniert',
  'Subscribed to': 'Abonniert',
  Summary: 'Zusammenfassung',
  Superseded: 'Ersetzt',
  'The decision': 'Die Entscheidung',
  'What went wrong': 'Fehlerursache',
  Why: 'Begründung',
  Wiki: 'Wiki',
  Wikis: 'Wikis',
  Write: 'Schreiben',
  Written: 'Verfasst',
  'Written by': 'Verfasst von',
  'A preset': 'Eine Vorgabe',
  'Exact scopes': 'Berechtigungen einzeln',
  Reader: 'Lesen',
  Contributor: 'Beitragen',
  'Every change': 'Alle Änderungen',
  'Awaiting review': 'Wartet auf Prüfung',
  Rejected: 'Abgelehnt',
  Split: 'Aufgeteilt',
  'Approved only': 'Nur freigegebene Inhalte',
  'Also archived sources': 'Auch archivierte Quellen',
  'Plain text': 'Nur Text',
  Link: 'Link',
  Verbatim: 'Originaltext',
  'New page': 'Neue Seite',
  'New wiki': 'Neues Wiki',
  'API keys': 'API-Schlüssel',
  Charter: 'Leitlinien',
  Changes: 'Änderungen',
  Search: 'Suche',
  System: 'System',
  Webhooks: 'Webhooks',
  Settings: 'Einstellungen',
  Show: 'Anzeigen',
  Open: 'Öffnen',
  Note: 'Notiz',
  Notes: 'Hinweise',
  Errors: 'Fehler',
  Warnings: 'Warnungen',
  Requests: 'Anfragen',
  Sessions: 'Sitzungen',
  'Tool calls': 'Werkzeugaufrufe',
  Tokens: 'Tokens',
  Calls: 'Aufrufe',
  Events: 'Ereignisse',
  Delivered: 'Zugestellt',
  Deliveries: 'Zustellungen',
  Endpoints: 'Endpunkte',
  Submitted: 'Eingereicht',
  Finished: 'Abgeschlossen',
  Succeeded: 'Erfolgreich',
  'Given up on': 'Aufgegeben',
  'Slowest 5%': 'Langsamste 5 %',
  'Each call': 'Je Aufruf',
  'People and agents': 'Personen und Agenten',
  'Not covered': 'Nicht abgedeckt',
  'Pages created': 'Erstellte Seiten',
  'Page revisions': 'Seitenrevisionen',
  'Sources archived': 'Archivierte Quellen',
  'Changes approved': 'Freigegebene Änderungen',
  'Disputed claims': 'Umstrittene Aussagen',
  'Untouched 90 days': 'Seit 90 Tagen unverändert',
  'Median time to decide': 'Mittlere Entscheidungszeit',
  'Changes opened or decided': 'Geöffnete oder entschiedene Änderungen',
  'People doing it': 'Beteiligte Personen',
  'What changed lately': 'Letzte Änderungen',
  'Connector streams': 'Konnektor-Datenströme',
  'Content hash': 'Inhalts-Hash',
  'Content is as of': 'Inhaltsstand',
  'Retrieval language': 'Abrufsprache',
  'Seen upstream': 'Im Quellsystem gesehen',
  Version: 'Version',
  Replaces: 'Ersetzt',
  'What it is': 'Dokumentart',
  'Copy address': 'Adresse kopieren',
  'Copy hash': 'Hash kopieren',
  'Copy key': 'Schlüssel kopieren',
  'Copy secret': 'Geheimnis kopieren',
  'Dismiss this job': 'Diesen Auftrag ausblenden',
  'Event types': 'Ereignisarten',
  'Which events': 'Ereignisse auswählen',
  'Register an endpoint': 'Endpunkt registrieren',
  'Register endpoint': 'Endpunkt registrieren',
  'Grant access': 'Zugriff gewähren',
  'Change ceiling': 'Berechtigungsgrenze ändern',
  'Mint a key': 'Schlüssel erstellen',
  'Mint key': 'Schlüssel erstellen',
  'Role preset': 'Rollenvorgabe',
  'Filter by status': 'Nach Status filtern',
  'Filter decisions by status': 'Entscheidungen nach Status filtern',
  'All changes': 'Alle Änderungen',
  'Show every change': 'Alle Änderungen anzeigen',
  'Show all decisions': 'Alle Entscheidungen anzeigen',
  'Approved knowledge': 'Freigegebenes Wissen',
  'Also search archived sources': 'Auch archivierte Quellen durchsuchen',
  'What to search': 'Suchbereich',
  'Which tiers to search': 'Zu durchsuchende Ebenen',
  'Ask instead of searching': 'Frage beantworten lassen',
  'Answer this question': 'Diese Frage beantworten',
  'A word or a phrase': 'Ein Wort oder eine Wortgruppe',
  'Alternatives turned down': 'Verworfene Alternativen',
  'Related pages': 'Verwandte Seiten',
  'Parent change': 'Übergeordnete Änderung',
  'Decided by': 'Entschieden von',
  'Review changes': 'Änderungen prüfen',
  Approve: 'Freigeben',
  'Defer this page': 'Diese Seite zurückstellen',
  'Split into one per page': 'Nach Seiten aufteilen',
  'Discard draft': 'Entwurf verwerfen',
  'Keep editing': 'Weiter bearbeiten',
  'Leave and lose it': 'Verlassen und verwerfen',
  'What has to change (required)': 'Erforderliche Änderung',
  Archive: 'Archiv',
  Article: 'Artikel',
  Meeting: 'Besprechung',
  'Plain Markdown. Every classification and synthesis job for this wiki reads it, so write the rules a contributor would need — scope, vocabulary, what is out of bounds.':
    'Reines Markdown. Jeder Klassifizierungs- und Syntheseauftrag liest diese Regeln. Beschreibe Geltungsbereich, Begriffe und Ausschlüsse.',
  'The rendered page appears here as you type.': 'Die gerenderte Seite erscheint hier während der Eingabe.',
  'Nightly handbook connector': 'Nächtlicher Handbuch-Konnektor',
  'The plaintext API key': 'Der API-Schlüssel im Klartext',
  'How to choose the scopes': 'Berechtigungen auswählen',
  'How to choose the ceiling': 'Berechtigungsgrenze auswählen',
  'Provider subject': 'Kennung beim Anbieter',
  'How this row should read': 'Angezeigter Name',
  'What this page is about': 'Worum es auf dieser Seite geht',
  'One sentence, shown in the page list and in search results':
    'Ein Satz, der in der Seitenliste und in Suchergebnissen erscheint',
  'Paste the document here.': 'Dokument hier einfügen.',
  'What this wiki knows about.': 'Wissensgebiet dieses Wikis.',
  'Questions about deployment, on-call and incident handling.':
    'Fragen zu Deployment, Rufbereitschaft und Störungsbehebung.',
  'What this wiki is for, what belongs in it, and how a page should be written.':
    'Zweck und Geltungsbereich dieses Wikis sowie Regeln für Seiten.',
  'The webhook signing secret': 'Das Signaturgeheimnis des Webhooks',
  'What this wiki learned lately, what is waiting for a reviewer, and where its knowledge is thin.':
    'Was dieses Wiki zuletzt gelernt hat, was auf Prüfung wartet und wo Nachweise fehlen.',
  'Every edit waiting for a decision, and every decision already made. Nothing becomes knowledge in this wiki until somebody here says yes.':
    'Alle Änderungen, die auf eine Entscheidung warten, und alle bereits getroffenen Entscheidungen. Erst eine Freigabe macht daraus Wissen.',
  'What this wiki decided and why, including the alternatives it turned down.':
    'Was dieses Wiki entschieden hat, warum und welche Alternativen verworfen wurden.',
  'Find what this wiki has approved — and, when you ask for it, the archived sources behind it.':
    'Freigegebenes Wissen und auf Wunsch die zugrunde liegenden archivierten Quellen finden.',
  'The governing document for this wiki: what it is for, what belongs in it, and how synthesis should read it.':
    'Die verbindlichen Regeln für Zweck, Geltungsbereich und Verarbeitung dieses Wikis.',
  'Every wiki this installation holds, what each one is for, and how each one is read.':
    'Alle Wikis dieser Installation, ihr Zweck und ihre Leseeinstellungen.',
  'The documents this wiki has archived verbatim. Every claim on every page quotes one of them.':
    'Die wörtlich archivierten Dokumente dieses Wikis. Jede Aussage zitiert eine dieser Quellen.',
  'Where this wiki tells other systems what happened — and, when something stopped arriving, which attempt failed and why.':
    'Ziele für Ereignisse dieses Wikis sowie fehlgeschlagene Zustellversuche und ihre Ursachen.',
  'Which build is serving, whether it is taking traffic, what the linter finds in this wiki, and what the endpoints have been doing.':
    'Ausgelieferter Build, Bereitschaft, Prüfbefunde und Endpunktaktivität.',
  'The credentials that reach WikiKit without a browser — what each one may do, where it may do it, and how to stop it.':
    'Zugänge ohne Browser, ihre Berechtigungen und Gültigkeitsbereiche sowie Möglichkeiten zum Widerruf.',
  'Who may sign in to this deployment and how far each of them reaches. The ceiling stored here is the only authorization WikiKit reads.':
    'Wer sich anmelden darf und welche Berechtigungsgrenze jeweils gilt.',
  "Archived verbatim when it was ingested, and read-only ever since — this is what the wiki's claims quote.":
    'Beim Import wörtlich archiviert und seitdem schreibgeschützt – daraus zitieren die Aussagen dieses Wikis.',
  'What this wiki knows on this subject, with the quote behind every claim it makes.':
    'Das Wissen dieses Wikis zu diesem Thema mit dem Beleg hinter jeder Aussage.',
  'Every claim on these pages has to be backed by a quote from an archived source. Read what this would publish, then decide.':
    'Jede Aussage auf diesen Seiten benötigt ein Zitat aus einer archivierten Quelle. Prüfe den Inhalt vor deiner Entscheidung.',
  'A decision this wiki recorded: what was decided, why, and what was turned down.':
    'Eine dokumentierte Entscheidung dieses Wikis mit Begründung und verworfenen Alternativen.',
  'Clear filter': 'Filter löschen',
  'Show every page': 'Alle Seiten anzeigen',
  'Deleted pages': 'Gelöschte Seiten',
  Restore: 'Wiederherstellen',
  'Changed within': 'Geändert innerhalb',
  'No pages changed in that window': 'In diesem Zeitraum wurden keine Seiten geändert',
  'No pages yet': 'Noch keine Seiten',
  'Untitled page': 'Seite ohne Titel',
  'Archived source': 'Archivierte Quelle',
  'Restoration submitted for review': 'Wiederherstellung zur Prüfung eingereicht',
  'The restoration is now waiting for review.': 'Die Wiederherstellung wartet jetzt auf Prüfung.',
  'Restore this page': 'Diese Seite wiederherstellen',
  'This submits restoration of the last visible revision for review.':
    'Die Wiederherstellung der letzten sichtbaren Revision wird zur Prüfung eingereicht.',
  'Submit restoration': 'Wiederherstellung einreichen',
  'Retained for audit. Restoring makes only the last visible revision current; relationships stay removed.':
    'Für die Nachvollziehbarkeit aufbewahrt. Beim Wiederherstellen wird nur die letzte sichtbare Revision aktuell; Beziehungen bleiben entfernt.',
  'A page states what this wiki knows, and every claim on it carries a verbatim quote from a source. Write one by hand, or add a document under Sources and review the pages it produces.':
    'Eine Seite beschreibt das Wissen dieses Wikis; jede Aussage enthält ein wörtliches Zitat aus einer Quelle. Schreibe eine Seite oder füge unter Quellen ein Dokument hinzu und prüfe die daraus erstellten Seiten.',
  'Every page this wiki holds. A page states what is known; editing one submits a change for review.':
    'Alle Seiten dieses Wikis. Eine Seite beschreibt bekanntes Wissen; eine Bearbeitung wird als Änderung zur Prüfung eingereicht.',
  'Needs knowledge:propose — writing a page means submitting a change for review.':
    'Erfordert knowledge:propose – eine neue Seite wird als Änderung zur Prüfung eingereicht.',
  'Needs knowledge:propose — restoration is a review-gated change.':
    'Erfordert knowledge:propose – eine Wiederherstellung muss geprüft werden.',
  'No claims': 'Keine Aussagen',
  'No claims yet': 'Noch keine Aussagen',
  'Add documents': 'Dokumente hinzufügen',
  'Agents on the MCP endpoint': 'Agenten am MCP-Endpunkt',
  'Asked for, not answered': 'Gesucht, aber nicht beantwortet',
  'Cited pages:': 'Zitierte Seiten:',
  Close: 'Schließen',
  'Documents coming in': 'Eingehende Dokumente',
  'Email (optional)': 'E-Mail (optional)',
  'Every HTTP request against this wiki — this console included.':
    'Jede HTTP-Anfrage an dieses Wiki – einschließlich dieses Cockpits.',
  'Every event': 'Alle Ereignisse',
  'Every page here is written from an archived document.':
    'Jede Seite hier wird aus einem archivierten Dokument erstellt.',
  'Every wiki': 'Jedes Wiki',
  'Evidence:': 'Nachweise:',
  'How far may they reach?': 'Welche Berechtigungen dürfen sie erhalten?',
  'Identity provider': 'Identitätsanbieter',
  'Kept in step by a connector': 'Durch einen Konnektor aktuell gehalten',
  Keywords: 'Schlüsselwörter',
  'Knowledge asked for': 'Gesuchtes Wissen',
  'Language (optional)': 'Sprache (optional)',
  'Leave without submitting?': 'Ohne Einreichen verlassen?',
  'Limit it to this wiki': 'Auf dieses Wiki begrenzen',
  'Markdown tree': 'Markdown-Baum',
  'Model work': 'Modellaktivität',
  More: 'Mehr',
  Name: 'Name',
  'Name (optional)': 'Name (optional)',
  Never: 'Nie',
  'Never signed in': 'Noch nie angemeldet',
  'Not approved knowledge': 'Nicht freigegebenes Wissen',
  'Nothing becomes visible knowledge until a person approves it.':
    'Nichts wird sichtbares Wissen, bevor eine Person es freigibt.',
  'Nothing — every login denied': 'Nichts – jede Anmeldung wird abgelehnt',
  "Only for a document that is not in the wiki's language.":
    'Nur für ein Dokument, das nicht in der Sprache des Wikis verfasst ist.',
  'Open Knowledge Format': 'Open Knowledge Format',
  'Pages this installation treats as reference targets': 'Seiten, die diese Installation als Referenzziele behandelt',
  Promise: 'Zusage',
  'Public review address': 'Öffentliche Prüfadresse',
  Record: 'Eintrag',
  'Review note': 'Prüfnotiz',
  Reviewing: 'Prüfaktivität',
  'Search language': 'Suchsprache',
  'Serving version': 'Ausgelieferte Version',
  Sidebar: 'Seitenleiste',
  Subject: 'Betreff',
  'Source evidence': 'Quellennachweise',
  'Superseded — kept as history': 'Ersetzt – im Verlauf aufbewahrt',
  'THIS change becomes terminal and can never move again.':
    'DIESE Änderung wird endgültig abgeschlossen und kann nicht erneut bearbeitet werden.',
  'Taking a wiki elsewhere': 'Wiki exportieren',
  'The archive record': 'Archiveintrag',
  'The document': 'Das Dokument',
  'There is no other wiki in this installation yet.': 'In dieser Installation gibt es noch kein weiteres Wiki.',
  'This build': 'Dieser Build',
  'This build serves': 'Dieser Build liefert aus',
  'This takes effect immediately.': 'Dies wird sofort wirksam.',
  'This wiki does not know.': 'Dieses Wiki weiß es nicht.',
  Title: 'Titel',
  'Title (optional)': 'Titel (optional)',
  'Use when': 'Verwenden bei',
  'Version history': 'Versionsverlauf',
  'Waiting for review': 'Wartet auf Prüfung',
  'Webhook delivery': 'Webhook-Zustellung',
  'What are you adding?': 'Was möchtest du hinzufügen?',
  'What is it? (optional)': 'Welche Art ist es? (optional)',
  'What is this key for?': 'Wofür wird dieser Schlüssel verwendet?',
  'What may it do?': 'Was darf er tun?',
  'What should it hear about?': 'Über welche Ereignisse soll es informiert werden?',
  'What this wiki told the outside world, and what never arrived.':
    'Was dieses Wiki an andere Systeme gesendet hat und was nicht angekommen ist.',
  'Where the knowledge is thin': 'Wo Nachweise fehlen',
  'WikiKit has no way to delete a wiki.': 'WikiKit bietet keine Möglichkeit, ein Wiki zu löschen.',
  'Your decision': 'Deine Entscheidung',
  added: 'hinzugefügt',
  'base moved on': 'Basis wurde geändert',
  'deactivated on approval': 'wird bei Freigabe deaktiviert',
  'every line is new — this page does not exist yet': 'Jede Zeile ist neu – diese Seite existiert noch nicht.',
  removed: 'entfernt',
  'text unchanged': 'Text unverändert',
  written: 'verfasst',
  pending: 'ausstehend',
  approved: 'freigegeben',
  rejected: 'abgelehnt',
  failed: 'fehlgeschlagen',
  split: 'aufgeteilt',
  active: 'aktiv',
  revoked: 'widerrufen',
  succeeded: 'erfolgreich',
  running: 'läuft',
  blocked: 'blockiert',
  unknown: 'unbekannt',
  warning: 'Warnung',
  error: 'Fehler',
  info: 'Hinweis',
  'No API keys': 'Keine API-Schlüssel',
  'Every agent, connector and script that reaches WikiKit presents one of these. People sign in instead, and their authority comes from an identity grant.':
    'Jeder Agent, Konnektor und jedes Skript verwendet einen solchen Schlüssel. Personen melden sich stattdessen an und erhalten ihre Berechtigungen über eine Identitätsfreigabe.',
  'This is what the filter is showing, not what the deployment holds. Switch to All to see every key.':
    'Der Filter zeigt nur einen Ausschnitt. Wähle „Alle“, um jeden Schlüssel zu sehen.',
  'Revoke this key?': 'Diesen Schlüssel widerrufen?',
  'Revoke key': 'Schlüssel widerrufen',
  'This key will never be shown again': 'Dieser Schlüssel wird nie wieder angezeigt',
  'No changes with that status': 'Keine Änderungen mit diesem Status',
  'No change has ever been raised in this wiki. Adding a document under Sources, or editing a page, is what puts one here.':
    'In diesem Wiki wurde noch keine Änderung eingereicht. Das Hinzufügen eines Dokuments unter Quellen oder das Bearbeiten einer Seite erzeugt eine Änderung.',
  'No source named': 'Keine Quelle angegeben',
  'This address is missing the id of a source. Open one from the Sources list.':
    'In dieser Adresse fehlt die Quelle. Öffne eine Quelle aus der Quellenliste.',
  'Delete this page': 'Diese Seite löschen',
  'This submits a deletion for review. History and evidence remain retained.':
    'Die Löschung wird zur Prüfung eingereicht. Verlauf und Nachweise bleiben erhalten.',
  'Submit deletion': 'Löschung einreichen',
  'This page has no text': 'Diese Seite enthält keinen Text',
  'Its revision carries claims but no prose. Editing it submits a change that gives it a document.':
    'Die Revision enthält Aussagen, aber keinen Fließtext. Eine Bearbeitung reicht ein Dokument als Änderung ein.',
  'No revisions recorded': 'Keine Revisionen vorhanden',
  'Every approved change writes a revision here. This page has none, which means nothing has been approved for it yet.':
    'Jede freigegebene Änderung erzeugt hier eine Revision. Für diese Seite wurde noch nichts freigegeben.',
  'A claim is one statement this page makes, tied to a verbatim quote from an archived source. Claims are produced by ingesting documents; a page written by hand starts without them.':
    'Eine Aussage ist mit einem wörtlichen Zitat aus einer archivierten Quelle verknüpft. Aussagen entstehen beim Einlesen von Dokumenten; eine manuell erstellte Seite beginnt ohne Aussagen.',
  'No decisions yet': 'Noch keine Entscheidungen',
  'A decision is recorded by the change that proposes it. Approve a change carrying one and it appears here, with its context, its rationale and the alternatives that were discarded.':
    'Eine Entscheidung wird durch die zugehörige Änderung erfasst. Nach der Freigabe erscheinen hier Kontext, Begründung und verworfene Alternativen.',
  'Nobody has been granted access': 'Niemand hat Zugriff erhalten',
  'A person signs in through an identity provider, and this grant is what decides whether that sign-in is allowed and what it may reach. Without a grant here, a successful login still reaches nothing.':
    'Eine Person meldet sich über einen Identitätsanbieter an. Diese Freigabe entscheidet, ob die Anmeldung zulässig ist und worauf sie zugreifen darf.',
  'This is what the filter is showing, not what the deployment holds. Switch to All to see every grant.':
    'Der Filter zeigt nur einen Ausschnitt. Wähle „Alle“, um jede Freigabe zu sehen.',
  "Revoke this person's access?": 'Zugriff dieser Person widerrufen?',
  'Revoke access': 'Zugriff widerrufen',
  'Re-admit this person?': 'Diese Person wieder zulassen?',
  'Restore access': 'Zugriff wiederherstellen',
  'This person already has a revoked grant': 'Für diese Person besteht bereits eine widerrufene Freigabe',
  'This person already has access': 'Diese Person hat bereits Zugriff',
  'These pages have moved on since this change was written':
    'Diese Seiten wurden seit Erstellung der Änderung weiterbearbeitet',
  'This change stages no pages': 'Diese Änderung enthält keine Seiten',
  'It only removes relations between pages that already exist. What it takes away is listed below.':
    'Sie entfernt ausschließlich Beziehungen zwischen vorhandenen Seiten. Die betroffenen Beziehungen sind unten aufgeführt.',
  'Approve and publish?': 'Freigeben und veröffentlichen?',
  'Approve and publish': 'Freigeben und veröffentlichen',
  'Send this back with a note?': 'Mit einer Notiz zurückgeben?',
  'The note IS the requested change — the author revises against it and submits a fresh change.':
    'Die Notiz beschreibt die gewünschte Überarbeitung. Anschließend wird eine neue Änderung eingereicht.',
  'Request changes': 'Änderungen anfordern',
  'Reject this change?': 'Diese Änderung ablehnen?',
  'Nothing is published and the change becomes terminal.':
    'Nichts wird veröffentlicht und die Änderung wird endgültig abgeschlossen.',
  Reject: 'Ablehnen',
  'Split into one change per page?': 'In eine Änderung pro Seite aufteilen?',
  'Nothing is decided and nothing is published — the pages are dealt out so they can be decided one at a time.':
    'Nichts wird entschieden oder veröffentlicht. Die Seiten werden getrennt, damit sie einzeln geprüft werden können.',
  'Split it up': 'Aufteilen',
  'The staged-content checks did not run': 'Die Prüfung der vorgemerkten Inhalte wurde nicht ausgeführt',
  'The staged-content checks found nothing': 'Die Prüfung der vorgemerkten Inhalte ergab keine Befunde',
  'This build publishes nothing about itself': 'Dieser Build veröffentlicht keine eigenen Beschreibungen',
  'No llms.txt, agent guide or OpenAPI document is bundled here, so there is nothing to fingerprint.':
    'Dieser Build enthält weder llms.txt, Agentenleitfaden noch OpenAPI-Dokument; daher kann kein Fingerabdruck gebildet werden.',
  'No marker is honoured here': 'Hier wird keine Markierung berücksichtigt',
  'This installation reported no revision markers at all, so every page is measured and linted as knowledge.':
    'Diese Installation meldet keine Revisionsmarkierungen. Daher wird jede Seite als Wissen gemessen und geprüft.',
  'Nothing to fix': 'Keine Befunde',
  'The linter found no errors, warnings or notes in this wiki.':
    'Die Prüfung fand in diesem Wiki keine Fehler, Warnungen oder Hinweise.',
  'No requests recorded': 'Keine Anfragen erfasst',
  'Nothing reached this wiki over HTTP in this window.': 'In diesem Zeitraum erreichte keine HTTP-Anfrage dieses Wiki.',
  'Nobody asked this wiki anything': 'Keine Wissensanfragen',
  'No search, read, question or ingest was recorded in this window.':
    'In diesem Zeitraum wurden weder Suche, Lesezugriff, Frage noch Import erfasst.',
  'No agent connected': 'Kein Agent verbunden',
  'No MCP session was recorded anywhere in this installation in this window.':
    'In diesem Zeitraum wurde in der gesamten Installation keine MCP-Sitzung erfasst.',
  'Discard this draft?': 'Diesen Entwurf verwerfen?',
  'The text goes back to what the wiki holds now.': 'Der Text wird auf den aktuellen Stand des Wikis zurückgesetzt.',
  Discard: 'Verwerfen',
  'Submit this change?': 'Diese Änderung einreichen?',
  'This does not publish anything.': 'Dadurch wird nichts veröffentlicht.',
  'Submit change': 'Änderung einreichen',
  'Search this wiki': 'Dieses Wiki durchsuchen',
  'Nothing is waiting': 'Nichts wartet auf eine Prüfung',
  'Every change proposed in this wiki has been decided.':
    'Über jede vorgeschlagene Änderung in diesem Wiki wurde entschieden.',
  'No review activity': 'Keine Prüfaktivität',
  'Nobody opened or decided a change in this window.':
    'In diesem Zeitraum wurde keine Änderung geöffnet oder entschieden.',
  'Write the charter': 'Leitlinien verfassen',
  'Write charter': 'Leitlinien schreiben',
  'Delete the charter': 'Leitlinien löschen',
  'Delete charter': 'Leitlinien löschen',
  'No charter yet': 'Noch keine Leitlinien',
  'Create this wiki': 'Dieses Wiki erstellen',
  'Create wiki': 'Wiki erstellen',
  'Save these settings': 'Diese Einstellungen speichern',
  'Save settings': 'Einstellungen speichern',
  'No sources yet': 'Noch keine Quellen',
  'A wiki with no evidence can hold no knowledge. Add a document and WikiKit archives it verbatim, then drafts pages that quote it.':
    'Ein Wiki ohne Nachweise kann kein Wissen enthalten. Füge ein Dokument hinzu; WikiKit archiviert es wörtlich und entwirft daraus zitierte Seiten.',
  'No connector streams': 'Keine Konnektor-Datenströme',
  'Forget this stream?': 'Diesen Datenstrom vergessen?',
  'Forget stream': 'Datenstrom vergessen',
  'No endpoints registered': 'Keine Endpunkte registriert',
  'Nothing outside WikiKit is being told about this wiki. Register a URL and WikiKit posts a signed event to it whenever a change is raised, approved or rejected.':
    'Kein externes System wird über dieses Wiki informiert. Registriere eine URL; WikiKit sendet signierte Ereignisse, wenn Änderungen eingereicht, freigegeben oder abgelehnt werden.',
  'Nothing has been sent yet': 'Noch nichts gesendet',
  'This secret will never be shown again': 'Dieses Geheimnis wird nie wieder angezeigt',
  'The endpoint was registered without a secret': 'Der Endpunkt wurde ohne Geheimnis registriert',
  Dismiss: 'Schließen',
  Notifications: 'Benachrichtigungen',
  'Toggle Sidebar': 'Seitenleiste ein-/ausblenden',
  breadcrumb: 'Brotkrümelnavigation',
  rows: 'Einträge',
  pages: 'Seiten',
  changes: 'Änderungen',
  sources: 'Quellen',
  decisions: 'Entscheidungen',
  keys: 'Schlüssel',
  grants: 'Freigaben',
  endpoints: 'Endpunkte',
  deliveries: 'Zustellungen',
  revisions: 'Revisionen',
  wikis: 'Wikis',
  '# Heading What this wiki knows, in Markdown.': '# Überschrift „Was dieses Wiki weiß“, in Markdown.',
  ', and the change becomes terminal.': ', und die Änderung wird endgültig.',
  ', last changed': ', zuletzt geändert',
  ', visible to every credential that is not bound to one particular wiki.':
    ', sichtbar für alle Anmeldeinformationen, die nicht an ein bestimmtes Wiki gebunden sind.',
  ', which belongs to no single page and would otherwise be stranded on this change once it goes terminal':
    ', der zu keiner einzelnen Seite gehört und sonst an dieser abgeschlossenen Änderung hängen bliebe',
  '. More than one build is behind this address.': '. Hinter dieser Adresse steckt mehr als ein Build.',
  ". Reading it is an admin's right, not a reader's — a session without it is told so here rather than shown a card that is missing.":
    '. Das Lesen ist das Recht eines Administrators, nicht das eines Lesers – eine Sitzung ohne dieses Recht wird hier mitgeteilt und nicht mit einer fehlenden Karte angezeigt.',
  '; rejecting closes the change and publishes nothing.':
    '; Durch das Ablehnen wird die Änderung geschlossen und nichts veröffentlicht.',
  'A change proposal is staged under the title “': 'Ein Änderungsvorschlag wird unter dem Titel „',
  'A charter tells WikiKit what this wiki is for, what belongs in it and what does not, and how a page should be written. It is read by classification and synthesis on every job — without one, they fall back to their defaults.':
    'Leitlinien beschreiben Zweck und Geltungsbereich des Wikis sowie die Schreibregeln. Klassifizierung und Synthese lesen sie bei jedem Auftrag; ohne Leitlinien gelten die Standardwerte.',
  'A meeting is also read for the decisions it records.':
    'Eine Besprechung wird auch für die darin aufgezeichneten Entscheidungen gelesen.',
  'A model reads the approved pages': 'Ein Modell liest die freigegebenen Seiten',
  'A new, empty wiki appears at': 'Ein neues, leeres Wiki erscheint unter',
  'A page keeps its address. Staging a different one would create a second page rather than rename this.':
    'Eine Seite behält ihre Adresse. Durch die Bereitstellung einer anderen Seite würde eine zweite Seite erstellt, anstatt diese umzubenennen.',
  'A wiki holds pages, the sources behind them and the changes waiting for review. Create one over the API to get started.':
    'Ein Wiki enthält Seiten, die dahinter stehenden Quellen und die Änderungen, die auf Überprüfung warten. Erstellen Sie eines über die API, um loszulegen.',
  'A wiki is a whole knowledge base: its own pages, sources, changes and charter. Nothing is shared with another wiki unless it is declared in Settings.':
    'Ein Wiki ist eine eigene Wissensbasis mit Seiten, Quellen, Änderungen und Leitlinien. Inhalte werden nur über ausdrücklich konfigurierte Verknüpfungen mit anderen Wikis geteilt.',
  'API keys that were killed when this grant was revoked do not come back. Anything running on one needs a new key.':
    'API-Schlüssel, die beim Widerruf dieser Gewährung gelöscht wurden, kommen nicht zurück. Alles, was darauf läuft, braucht einen neuen Schlüssel.',
  'An https:// address WikiKit can reach. Deliveries are POSTs, so this URL never needs to answer a browser.':
    'Eine für WikiKit erreichbare HTTPS-Adresse. Ereignisse werden per POST zugestellt; die URL muss keine Browserseite ausliefern.',
  And: 'Und',
  'Audited, and shown to whatever writes the next version. A bounce without guidance is just a rejection.':
    'Geprüft und dem Autor der nächsten Version angezeigt. Ein Sprung ohne Führung ist nur eine Ablehnung.',
  'Being added': 'Wird hinzugefügt',
  'Charter (Markdown)': 'Leitlinien (Markdown)',
  'Checks —': 'Prüfungen –',
  'Claims (': 'Aussagen (',
  'Claims and the quotes behind them come from ingesting sources under Sources. A page written here stages its text and nothing else.':
    'Aussagen und ihre Zitate entstehen beim Einlesen von Quellen. Eine hier verfasste Seite merkt nur ihren Text zur Prüfung vor.',
  'Claims somebody disputed, pages nobody has revisited, and how long a change waits.':
    'Behauptungen, die jemand bestritten hat, Seiten, die niemand noch einmal besucht hat, und wie lange auf eine Änderung gewartet wird.',
  'Closing this panel discards it. WikiKit kept the hash, not the key.':
    'Durch das Schließen dieses Panels wird es verworfen. WikiKit hat den Hash behalten, nicht den Schlüssel.',
  'Comma separated. These weigh heaviest when WikiKit picks a wiki for a task, so a handful of exact terms beats a paragraph.':
    'Komma getrennt. Diese wiegen am schwersten, wenn WikiKit ein Wiki für eine Aufgabe auswählt, sodass eine Handvoll genauer Begriffe einen Absatz übertrifft.',
  'Contradicts a claim already visible on the same frame — approval marks BOTH of them disputed.':
    'Widerspricht einer Behauptung, die bereits auf demselben Rahmen sichtbar ist – Genehmigungszeichen, BEIDE umstritten.',
  'Could not list wikis': 'Wikis konnten nicht aufgelistet werden',
  'Decisions recorded by this change (': 'Durch diese Änderung erfasste Entscheidungen (',
  'Derived from current knowledge and appended to the charter automatically, together with an index of every page in this wiki. It is not part of the text above and cannot be edited here.':
    'Aus aktuellem Wissensstand abgeleitet und automatisch der Charta beigefügt, zusammen mit einem Index aller Seiten in diesem Wiki. Es ist nicht Teil des obigen Textes und kann hier nicht bearbeitet werden.',
  'Displays the mobile sidebar.': 'Zeigt die mobile Seitenleiste an.',
  'Emptying either box removes what is stored. The email does not stay empty: every sign-in writes back whatever the provider asserts. To keep it gone, clear it and then revoke the grant — a revoked identity cannot sign in, so nothing rewrites it — or remove the person at the provider.':
    'Durch das Leeren einer der beiden Boxen wird der gespeicherte Inhalt entfernt. Die E-Mail bleibt nicht leer: Bei jedem Login wird zurückgeschrieben, was der Anbieter behauptet. Um es nicht mehr zu löschen, löschen Sie es und widerrufen Sie dann die Gewährung – eine widerrufene Identität kann sich nicht anmelden, daher wird sie nicht neu geschrieben – oder entfernen Sie die Person beim Anbieter.',
  'Every MCP client this installation serves, across all wikis rather than just':
    'Jeder MCP-Client, den diese Installation bedient, in allen Wikis und nicht nur',
  'Every charter written for this wiki, newest first. Writing supersedes the current revision rather than overwriting it.':
    'Jede für dieses Wiki geschriebene Charta, die neueste zuerst. Beim Schreiben wird die aktuelle Revision ersetzt, anstatt sie zu überschreiben.',
  'Every claim carries a citation, no claim collides with a visible one, and no relation points at a page that is not there.':
    'Jeder Anspruch trägt ein Zitat, kein Anspruch kollidiert mit einem sichtbaren Anspruch und keine Beziehung verweist auf eine Seite, die nicht vorhanden ist.',
  "Every finding names a page, and each one is shown with that page's diff below.":
    'Jedes Ergebnis benennt eine Seite und jedes wird unten mit dem Diff dieser Seite angezeigt.',
  'Every question readers asked found an answer.': 'Auf jede Frage, die die Leser stellten, gab es eine Antwort.',
  'Every request that presents this key is refused from now on — reads, proposals, reviews and ingests alike. Anything running on it stops: a connector pushing documents, an agent drafting pages, a script polling the review queue. Sessions already signed in are unaffected; this is one credential, not a person.':
    'Jede Anfrage, die diesen Schlüssel präsentiert, wird von nun an abgelehnt – Lesevorgänge, Vorschläge, Rezensionen und Aufnahmen gleichermaßen. Alles, was darauf läuft, stoppt: ein Connector, der Dokumente pusht, ein Agent, der Seiten erstellt, ein Skript, das die Überprüfungswarteschlange abfragt. Bereits angemeldete Sitzungen sind davon nicht betroffen; Hierbei handelt es sich um einen Ausweis, nicht um eine Person.',
  'Every source in this wiki was added by hand. A stream appears when a connector pushes a document with a stable id, so later versions of it replace this one instead of forking the archive.':
    'Jede Quelle in diesem Wiki wurde von Hand hinzugefügt. Ein Stream wird angezeigt, wenn ein Connector ein Dokument mit einer stabilen ID weiterleitet. Daher ersetzen spätere Versionen dieses Dokument, anstatt das Archiv zu forken.',
  'Every stored page and source in this wiki is re-indexed on save — search results will differ afterwards, and nothing about the text itself changes.':
    'Jede gespeicherte Seite und Quelle in diesem Wiki wird beim Speichern neu indiziert – die Suchergebnisse unterscheiden sich danach und am Text selbst ändert sich nichts.',
  Export: 'Export',
  'Found only in archived sources — not approved knowledge':
    'Nur in archivierten Quellen zu finden – kein anerkanntes Wissen',
  'Granting again would be refused. Restore': 'Eine erneute Gewährung würde abgelehnt. Wiederherstellen',
  'How search reduces words before matching them. Changing it rebuilds the search index for every page and source in this wiki.':
    'Wie die Suche Wörter reduziert, bevor sie mit ihnen übereinstimmt. Wenn Sie es ändern, wird der Suchindex für jede Seite und Quelle in diesem Wiki neu erstellt.',
  'How this wiki describes itself to agents, which language its search is stemmed in, and which other wikis it may read.':
    'Wie sich dieses Wiki den Agenten selbst beschreibt, in welcher Sprache die Suche erfolgt und welche anderen Wikis es möglicherweise liest.',
  'How to read this document': 'So lesen Sie dieses Dokument',
  'I have stored it — close': 'Ich habe ihn gespeichert – schließen',
  'Importing a bundle is not done from this console. Sources in an imported bundle are archived directly — evidence asserts nothing — but its pages and claims are staged as a single change for review, exactly like knowledge WikiKit synthesized itself. Use the API or the CLI, then review the change it raises.':
    'Der Import eines Bundles erfolgt nicht über diese Konsole. Quellen in einem importierten Paket werden direkt archiviert – Beweise belegen nichts – aber seine Seiten und Behauptungen werden als einzelne Änderung zur Überprüfung bereitgestellt, genau wie das Wissen, das WikiKit selbst synthetisiert hat. Verwenden Sie die API oder die CLI und überprüfen Sie dann die dadurch ausgelöste Änderung.',
  In: 'In',
  'Including event types added in later releases — an endpoint that subscribes to everything keeps subscribing to everything.':
    'Einschließlich der in späteren Versionen hinzugefügten Ereignistypen – ein Endpunkt, der alles abonniert, abonniert weiterhin alles.',
  'Knowledge health in': 'Wissensqualität in',
  'Lower-case letters, digits and hyphens. Every link to this page will use it, so it does not change later.':
    'Kleinbuchstaben, Ziffern und Bindestriche. Jeder Link zu dieser Seite verwendet es, sodass es sich später nicht ändert.',
  'Lower-case letters, digits and hyphens. It is the address of this wiki in every URL and every API call, and it cannot be changed afterwards.':
    'Kleinbuchstaben, Ziffern und Bindestriche. Es ist die Adresse dieses Wikis in jeder URL und jedem API-Aufruf und kann nachträglich nicht mehr geändert werden.',
  'Move this one page into a change of its own, so the rest can be decided now.':
    'Verschieben Sie diese eine Seite in eine eigene Änderung, damit der Rest jetzt entschieden werden kann.',
  'Name the claim that is unsupported, or the source that has to be quoted.':
    'Nennen Sie die Behauptung, die nicht unterstützt wird, oder die Quelle, die zitiert werden muss.',
  'No archived source is attached. Every claim above is therefore unciteable — that is what the missing-citations check reports.':
    'Es ist keine archivierte Quelle angehängt. Jede der oben genannten Behauptungen ist daher nicht zitierfähig – das zeigt die Prüfung auf fehlende Zitate.',
  'No charter has ever been written for this wiki.': 'Für dieses Wiki wurde noch nie eine Charta verfasst.',
  'No citation. Nothing in an archived source says this.': 'Kein Zitat. Nichts in einer archivierten Quelle sagt dies.',
  'No preset can approve a change or administer this installation. Approving is what publishes knowledge and':
    'Kein Preset kann eine Änderung genehmigen oder diese Installation verwalten. Genehmigen ist das, was Wissen veröffentlicht und',
  'No wikis yet': 'Noch keine Wikis',
  'Not stated': 'Nicht angegeben',
  'Nothing already written is touched. Sources stay archived, pages stay visible, and changes this key raised stay in the queue for a human to decide.':
    'Nichts bereits Geschriebenes wird berührt. Quellen bleiben archiviert, Seiten bleiben sichtbar und Änderungen, die dieser Schlüssel verursacht, bleiben in der Warteschlange, damit ein Mensch darüber entscheiden kann.',
  'Nothing approved here answers that question. Adding a source is how the wiki learns it.':
    'Nichts, was hier genehmigt wurde, beantwortet diese Frage. Durch das Hinzufügen einer Quelle lernt das Wiki diese.',
  'Nothing in the archive is quoted for this claim, so nobody can check it.':
    'Zu dieser Behauptung wird im Archiv nichts zitiert, so dass niemand sie überprüfen kann.',
  'Nothing is deleted. The versions already archived stay exactly as they are, and every page that quotes them keeps its evidence — a claim never loses its citation.':
    'Es wird nichts gelöscht. Die bereits archivierten Versionen bleiben genau so, wie sie sind, und jede Seite, die sie zitiert, behält ihre Beweise – eine Behauptung verliert nie ihre Zitierung.',
  'Nothing is published. This change is closed for good and marked as having changes requested; WikiKit has no rebase, so acting on your note produces a NEW change rather than an edit to this one.':
    'Es wird nichts veröffentlicht. Diese Änderung ist endgültig geschlossen und als Änderungswunsch markiert; WikiKit hat kein Rebase, daher führt die Reaktion auf Ihre Notiz eher zu einer NEUEN Änderung als zu einer Bearbeitung dieser Änderung.',
  'Nothing — this is the first version': 'Nichts – das ist die erste Version',
  'One file per page, decision and source. Readable in any editor.':
    'Eine Datei pro Seite, Entscheidung und Quelle. In jedem Editor lesbar.',
  'One or two sentences. An agent asked to find the right wiki for a task is matched against this.':
    'Ein oder zwei Sätze. Ein Agent, der gebeten wird, das richtige Wiki für eine Aufgabe zu finden, wird diesem zugeordnet.',
  "One stream is one upstream document that a connector keeps in step — each push archives a new version and moves the stream's head.":
    'Ein Stream ist ein Upstream-Dokument, das ein Konnektor im Takt hält – jeder Push archiviert eine neue Version und verschiebt den Kopf des Streams.',
  'Other wikis this one may search and link into. A page here can reference a page there only if the wiki is declared, so this is a deliberate widening of what readers of this wiki can see.':
    'Andere Wikis, in denen dieses Wiki durchsucht und verlinkt werden kann. Eine Seite hier kann nur dann auf eine Seite dort verweisen, wenn das Wiki deklariert ist. Dies ist also eine bewusste Erweiterung dessen, was Leser dieses Wikis sehen können.',
  'Part of this answer rests on archived sources rather than on approved knowledge':
    'Ein Teil dieser Antwort beruht eher auf archivierten Quellen als auf bestätigtem Wissen',
  'Paused until': 'Pausiert bis',
  'Platform runbooks': 'Plattform-Runbooks',
  Provenance: 'Herkunft',
  'Purpose, use-when and keywords change which wiki an agent is pointed at for a task. Nothing already written changes, and no page moves.':
    'Zweck, Verwendungszeitpunkt und Schlüsselwörter ändern, auf welches Wiki ein Agent für eine Aufgabe verwiesen wird. Es ändert sich nichts bereits Geschriebenes und es werden keine Seiten verschoben.',
  'Quote from': 'Zitat von',
  'Read the': 'Lesen Sie die',
  'Read the archived source': 'Lesen Sie die archivierte Quelle',
  Reading: 'Lektüre',
  'Reading from': 'Lesen aus',
  'Ready to copy': 'Bereit zum Kopieren',
  'Relations this change takes away (': 'Beziehungen, die diese Änderung wegnimmt (',
  'Relations this page adds (': 'Beziehungen, die diese Seite hinzufügt (',
  'Replaced by': 'Ersetzt durch',
  'Requests to': 'Anfragen an',
  'Results come in two tiers: what this wiki has approved, and — if you ask for them — lines found only in the archived sources behind it. The second tier is evidence, not knowledge.':
    'Die Ergebnisse gibt es auf zwei Ebenen: was dieses Wiki genehmigt hat und – wenn Sie danach fragen – Zeilen, die nur in den archivierten Quellen dahinter zu finden sind. Die zweite Stufe besteht aus Beweisen, nicht aus Wissen.',
  'Review the change →': 'Überprüfen Sie die Änderung →',
  Searched: 'Gesucht',
  'Searches, reads, questions, ingests and proposals — through this console, the API and agents alike.':
    'Suchvorgänge, Lesevorgänge, Fragen, Aufnahmen und Vorschläge – über diese Konsole, die API und Agenten gleichermaßen.',
  'Settings —': 'Einstellungen -',
  'Signing in again will not help — the provider may still authenticate them, and WikiKit will still refuse. Only an explicit restore on this page re-admits them, and it re-admits them at the same ceiling they have now.':
    'Eine erneute Anmeldung hilft nicht – der Anbieter authentifiziert sie möglicherweise trotzdem und WikiKit lehnt dies weiterhin ab. Nur durch eine explizite Wiederherstellung auf dieser Seite werden sie wieder zugelassen, und zwar mit der gleichen Obergrenze, die sie jetzt haben.',
  'Sources behind this change (': 'Quellen hinter dieser Änderung (',
  'Stated with confidence': 'Mit Zuversicht erklärt',
  'The ceiling this grant already carries comes back with it —':
    'Die bisherige Berechtigungsgrenze wird wiederhergestellt –',
  'The change that made it': 'Die Veränderung, die es bewirkt hat',
  'The charter is not reviewed: it is configuration an admin owns, so no change proposal is created and nobody approves it.':
    'Die Charta wird nicht überprüft: Es handelt sich um eine Konfiguration, die einem Administrator gehört, daher wird kein Änderungsvorschlag erstellt und niemand genehmigt ihn.',
  'The diff above is unaffected — this check is advisory. Nothing here says the change is clean; it says nobody looked.':
    'Der obige Unterschied ist davon nicht betroffen – diese Prüfung ist beratend. Nichts hier besagt, dass die Änderung sauber ist; Es heißt, niemand hat nachgeschaut.',
  'The id of a provider this deployment is configured to authenticate against. Anything else is refused — a typo would otherwise create a grant no login can ever match.':
    'Die ID eines Anbieters, bei dem diese Bereitstellung für die Authentifizierung konfiguriert ist. Alles andere wird abgelehnt – ein Tippfehler würde andernfalls zu einer Bewilligung führen, mit der kein Login jemals übereinstimmen kann.',
  'The interchange bundle: claims, citations and relations survive the round trip.':
    'Das Austauschbündel: Ansprüche, Zitate und Beziehungen überleben den Hin- und Rückweg.',
  'The model returned no answer.': 'Das Modell gab keine Antwort zurück.',
  'The name is the only thing that will identify this key afterwards — the key itself is never shown again and never stored.':
    'Der Name ist das Einzige, was diesen Schlüssel später identifiziert – der Schlüssel selbst wird nie wieder angezeigt und nie gespeichert.',
  "The receiving system verifies every delivery's signature with it. Without it, it cannot tell a WikiKit event from anything else that can reach the URL.":
    'Das Empfangssystem prüft damit die Unterschrift jeder Lieferung. Ohne sie kann ein WikiKit-Ereignis nicht von irgendetwas anderem unterschieden werden, das die URL erreichen kann.',
  'The search language changes to': 'Die Suchsprache ändert sich zu',
  'The situation that should send somebody here rather than to another wiki.':
    'Die Situation, die jemanden hierher schicken sollte, anstatt zu einem anderen Wiki.',
  'The slug is permanent and is the address every link, API call and export filename will carry.':
    'Der Slug ist dauerhaft und ist die Adresse, die jeder Link, jeder API-Aufruf und jeder Exportdateiname tragen wird.',
  'The source this is quoted from': 'Die Quelle, aus der hier zitiert wird',
  'The stable id the provider sends for this person — not their email, which they can change.':
    'Die stabile ID, die der Anbieter für diese Person sendet – nicht ihre E-Mail-Adresse, die sie ändern kann.',
  'The staged text is kept for the audit trail but never becomes visible. Use “Request changes” instead when the author should try again — a bare rejection carries no instruction.':
    'Der bereitgestellte Text wird für den Audit-Trail aufbewahrt, wird jedoch nie sichtbar. Verwenden Sie stattdessen „Änderungen anfordern“, wenn der Autor es erneut versuchen soll – eine bloße Ablehnung enthält keine Anweisung.',
  'The version before this one': 'Die Version vor dieser',
  'The version this process is serving, and a fingerprint of every document it publishes about itself — so a deployment can be compared without downloading any of them.':
    'Die Version, die dieser Prozess bereitstellt, und ein Fingerabdruck jedes Dokuments, das er über sich selbst veröffentlicht – sodass eine Bereitstellung verglichen werden kann, ohne dass eines davon heruntergeladen werden muss.',
  'Their work stays. Pages they wrote stay visible, changes they raised stay in the queue, and decisions they approved stay approved — revoking access has never rewritten history here.':
    'Ihre Arbeit bleibt. Von ihnen geschriebene Seiten bleiben sichtbar, von ihnen vorgenommene Änderungen bleiben in der Warteschlange und von ihnen genehmigte Entscheidungen bleiben genehmigt – der Widerruf des Zugriffs hat hier noch nie die Geschichte neu geschrieben.',
  'There is no preset that can approve a change. Approving publishes knowledge, so':
    'Es gibt keine Voreinstellung, die eine Änderung genehmigen kann. Die Genehmigung veröffentlicht Wissen, also',
  'There is no way back. WikiKit stores a hash and never the key, so a revoked key cannot be re-enabled — mint a replacement, hand it to whatever was using this one, and revoke afterwards to avoid a gap.':
    'Es gibt keinen Weg zurück. WikiKit speichert einen Hash und niemals den Schlüssel, sodass ein widerrufener Schlüssel nicht erneut aktiviert werden kann – erstellen Sie einen Ersatz, geben Sie ihn an denjenigen weiter, der diesen verwendet hat, und widerrufen Sie ihn anschließend, um eine Lücke zu vermeiden.',
  "This decision is yours, not an agent's. Approving publishes the pages above into":
    'Diese Entscheidung liegt bei Ihnen, nicht bei einem Agenten. Durch die Genehmigung werden die oben genannten Seiten veröffentlicht',
  'This document has a stable id upstream, so each push archives a new version instead of forking the archive. Older versions stay exactly where they are — the claims that quote them keep their evidence.':
    'Dieses Dokument verfügt über eine stabile Upstream-ID, sodass bei jedem Push eine neue Version archiviert wird, anstatt das Archiv zu forken. Ältere Versionen bleiben genau dort, wo sie sind – die Behauptungen, die sie zitieren, behalten ihre Beweise.',
  'This document is too large to diff line by line without freezing the tab. Here is what it says now, then what it would say.':
    'Dieses Dokument ist zu groß, um es Zeile für Zeile zu unterscheiden, ohne die Registerkarte einzufrieren. Hier ist, was es jetzt sagt und was es damals sagen würde.',
  'This draft exists only in this browser. Leaving now throws it away — nothing has been sent to WikiKit yet, so there is no change to come back to.':
    'Dieser Entwurf existiert nur in diesem Browser. Wenn Sie jetzt gehen, wird es weggeworfen – es wurde noch nichts an WikiKit gesendet, es gibt also keine Änderung, auf die Sie zurückkommen könnten.',
  'This endpoint is registered and no event it subscribes to has happened since. That is good news, not a fault — raise or approve a change and the first delivery appears here.':
    'Dieser Endpunkt ist registriert und seitdem ist kein Ereignis aufgetreten, das er abonniert hat. Das ist eine gute Nachricht, kein Fehler – erheben oder genehmigen Sie eine Änderung und die erste Lieferung erscheint hier.',
  'This form did not load their row, so a name or email left blank here keeps what is stored rather than clearing it. To remove either one, close this and use Change ceiling on their row.':
    'Dieses Formular hat den vorhandenen Eintrag nicht geladen. Leere Felder behalten daher den gespeicherten Namen oder die E-Mail-Adresse. Zum Entfernen schließe den Dialog und öffne am Eintrag „Berechtigungsgrenze ändern“.',
  'This grant is the only authorization WikiKit reads, so revoking it takes effect immediately and everywhere: the sessions this person has open right now stop working mid-request, and any API key minted through this identity is killed with it. A key bound to a grant cannot outlive the grant.':
    'Diese Gewährung ist die einzige Berechtigung, die WikiKit liest, daher wird der Widerruf sofort und überall wirksam: Die Sitzungen, die diese Person gerade geöffnet hat, funktionieren während der Anfrage nicht mehr, und jeder über diese Identität geprägte API-Schlüssel wird damit gelöscht. Ein an einen Zuschuss gebundener Schlüssel kann den Zuschuss nicht überleben.',
  'This installation answered with two versions —': 'Diese Installation antwortete mit zwei Versionen –',
  'This installation holds no wikis yet.': 'Diese Installation enthält noch keine Wikis.',
  'This record does not name what replaced it. The': 'Dieser Datensatz nennt nicht, was ihn ersetzt hat. Der',
  'This record names none.': 'Dieser Datensatz nennt keine.',
  "This wiki's language": 'Die Sprache dieses Wikis',
  'Unanswered-question tracking is switched off in this deployment.':
    'Die Nachverfolgung unbeantworteter Fragen ist in dieser Bereitstellung deaktiviert.',
  Unstemmed: 'Ohne Wortstammerkennung',
  'Until a new charter is written, nothing steers classification and synthesis for this wiki: they fall back to their defaults. Pages already written are unaffected.':
    'Bis eine neue Charta verfasst ist, steuert nichts die Klassifizierung und Synthese für dieses Wiki: Sie greifen auf ihre Standardwerte zurück. Bereits geschriebene Seiten bleiben davon unberührt.',
  'What WikiKit knows about these bytes. The hash is what makes the same document ingested twice one source rather than two.':
    'Was WikiKit über diese Bytes weiß. Der Hash ist dafür verantwortlich, dass das gleiche Dokument, das zweimal aufgenommen wurde, eine Quelle statt zwei ist.',
  'What a person calls it. This one can be changed later.':
    'Wie eine Person es nennt. Dieser kann später geändert werden.',
  "What changes: this stream leaves the list below, and the wiki's lint report starts naming the visible claims whose upstream document no longer exists, so a human can decide what to do about them. A later push from the connector brings the stream back.":
    'Was sich ändert: Dieser Stream verlässt die Liste unten und der Lint-Bericht des Wikis beginnt mit der Benennung der sichtbaren Ansprüche, deren Originaldokument nicht mehr existiert, sodass ein Mensch entscheiden kann, was mit ihnen zu tun ist. Ein späterer Push vom Connector bringt den Stream zurück.',
  'What reviewers did here — through this console, the API and agents alike.':
    'Was die Rezensenten hier getan haben – über diese Konsole, die API und Agenten gleichermaßen.',
  'What synthesis cost this wiki: calls, tokens and time, from the audit ledger.':
    'Welche Synthese kostet dieses Wiki: Aufrufe, Token und Zeit aus dem Audit-Ledger.',
  'What the linter finds in this wiki: claims with no quote behind them, pages nothing links to, changes nobody has reviewed.':
    'Was der Linter in diesem Wiki findet: Behauptungen ohne Zitat dahinter, Seiten, auf die nichts verlinkt ist, Änderungen, die niemand überprüft hat.',
  'Where it came from': 'Woher es kam',
  "Which markers count is configuration, so it differs between installations — this is what yours honours. Reading it is an admin's right, not a reader's; a session without it is told so here rather than shown a card that is missing.":
    'Welche Markierungen zählen, hängt von der Konfiguration ab und unterscheidet sich daher je nach Installation – dies ist Ihre Ehre. Es ist das Recht eines Administrators, es zu lesen, nicht das eines Lesers. Eine Sitzung ohne sie wird hier also mitgeteilt, anstatt eine Karte anzuzeigen, die fehlt.',
  'WikiKit archives what you give it verbatim, quotes it claim by claim into pages, and puts those pages in Changes for a human to approve. Nothing becomes visible knowledge here without that approval.':
    'WikiKit archiviert, was Sie ihm wörtlich geben, zitiert es Anspruch für Anspruch in Seiten und fügt diese Seiten in Änderungen ein, damit ein Mensch sie genehmigen kann. Ohne diese Zustimmung wird hier nichts sichtbares Wissen.',
  "WikiKit created the endpoint but sent no signing secret back, so there is nothing to give the receiving system. Delete this endpoint and register it again; if it happens twice, this deployment's webhook surface needs looking at before anything is wired to it.":
    'WikiKit hat den Endpunkt erstellt, aber kein Signaturgeheimnis zurückgesendet, sodass dem empfangenden System nichts weitergegeben werden kann. Löschen Sie diesen Endpunkt und registrieren Sie ihn erneut; Wenn es zweimal passiert, muss die Webhook-Oberfläche dieser Bereitstellung überprüft werden, bevor etwas damit verbunden wird.',
  'WikiKit does not answer which pages cite this source. To find them, search the wiki for a phrase from the document — every claim carries its quote.':
    'WikiKit antwortet nicht, welche Seiten diese Quelle zitieren. Um sie zu finden, durchsuchen Sie das Wiki nach einem Satz aus dem Dokument – ​​jede Behauptung enthält ein Zitat.',
  "WikiKit reads this ceiling on every request, so whatever you set here is in force on this person's next call — there is no session to wait out and nothing to re-issue.":
    'WikiKit liest diese Obergrenze bei jeder Anfrage, sodass alles, was Sie hier festlegen, beim nächsten Anruf dieser Person wirksam ist – es gibt keine Sitzung, die abgewartet werden muss, und nichts, was erneut ausgegeben werden muss.',
  'Write the page in Markdown. Submitting stages a change — a reviewer decides whether it becomes part of the wiki.':
    'Schreiben Sie die Seite in Markdown. Durch das Einreichen wird eine Änderung inszeniert – ein Prüfer entscheidet, ob sie Teil des Wikis wird.',
  and: 'Und',
  'and answers in prose, citing what it used. It costs model tokens, so it runs only when you ask.':
    'und antwortet in Prosa unter Angabe dessen, was verwendet wurde. Es kostet Modelltokens und wird daher nur ausgeführt, wenn Sie danach fragen.',
  'are chosen scope by scope, on purpose.': 'werden absichtlich Bereich für Bereich ausgewählt.',
  'becomes current the moment you confirm, and revision':
    'wird zum Zeitpunkt Ihrer Bestätigung und Überarbeitung aktuell',
  'can never be granted to a person — it means “everything, including whatever is added later”, which is a grant nobody can audit. That stays a key somebody minted on the host.':
    'kann niemals einer Person gewährt werden – es bedeutet „alles, einschließlich allem, was später hinzugefügt wird“, was eine Gewährung ist, die niemand überprüfen kann. Das bleibt ein Schlüssel, den jemand dem Gastgeber eingeprägt hat.',
  collides: 'kollidiert',
  'decision log': 'Entscheidungsprotokoll',
  'error(s),': 'Fehler,',
  'evidence to follow up — not something this wiki knows.':
    'Beweise, die weiterverfolgt werden müssen – etwas, das dieses Wiki nicht weiß.',
  'from a document this wiki archived. Nobody has reviewed':
    'aus einem Dokument, das dieses Wiki archiviert hat. Niemand hat eine Bewertung abgegeben',
  'from the list instead — it re-admits them at the ceiling that grant already carries.':
    'Stattdessen werden sie von der Liste gestrichen – sie werden mit der Obergrenze, die für den Zuschuss bereits gilt, wieder aufgenommen.',
  'has to be chosen scope by scope, on purpose.': 'muss Bereich für Bereich absichtlich ausgewählt werden.',
  'into a page, so': 'in eine Seite, also',
  'is a zip of ordinary files — one per page, decision and source, plus an index. It is what to hand somebody who just wants to read the knowledge, and it is lossy: claims, citations and relations are prose in it, not structure.':
    'ist eine ZIP-Datei mit gewöhnlichen Dateien – eine pro Seite, Entscheidung und Quelle sowie ein Index. Es ist etwas, das man jemandem geben kann, der das Wissen einfach nur lesen möchte, und es ist verlustbehaftet: Behauptungen, Zitate und Beziehungen sind darin Prosa, keine Struktur.',
  'is already admitted on this provider and subject, so this is not a new grant. Submitting replaces their current ceiling —':
    'ist für diesen Anbieter und Fachbereich bereits zugelassen, es handelt sich also nicht um eine neue Förderung. Die Einreichung ersetzt ihre aktuelle Obergrenze –',
  'is left with no charter. Every revision stays readable in the history below — this deletes what is in force, not the record of it.':
    'bleibt ohne Charter. Jede Revision bleibt in der Historie unten lesbar – dadurch wird die gültige Version gelöscht, nicht deren Aufzeichnung.',
  'is superseded and': 'wird ersetzt und',
  'is superseded — kept in history, no longer in force. Classification and synthesis in':
    'wird ersetzt – in der Geschichte beibehalten, nicht mehr in Kraft. Klassifizierung und Synthese in',
  'is the interchange bundle. It carries the structure as well as the text, so a wiki exported from one WikiKit and imported into another arrives with its claims still quoting their sources.':
    'ist das Austauschbündel. Es trägt sowohl die Struktur als auch den Text, sodass ein Wiki, das aus einem WikiKit exportiert und in ein anderes importiert wird, mit seinen Ansprüchen ankommt, die immer noch ihre Quellen angeben.',
  'more.': 'mehr.',
  'no other wiki': 'kein anderes Wiki',
  'not created yet': 'noch nicht erstellt',
  'note(s)': 'Notiz(en)',
  'on pages a human reviewed and published.': 'auf Seiten, die ein Mensch überprüft und veröffentlicht hat.',
  'pages become': 'Seiten werden',
  'pending changes, one per page': 'ausstehende Änderungen, eine pro Seite',
  'plus one more —': 'plus noch eins –',
  'reaches every other scope, including minting and revoking keys and deciding who may sign in.':
    'erstreckt sich auf jeden anderen Bereich, einschließlich der Prägung und des Widerrufs von Schlüsseln und der Entscheidung, wer sich anmelden darf.',
  'reaches the credentials themselves, so': 'erreicht die Anmeldeinformationen selbst, also',
  'read the new text from their next job onwards; pages already written are not revisited.':
    'den neuen Text ab dem nächsten Job lesen; Bereits geschriebene Seiten werden nicht noch einmal aufgegriffen.',
  'shows what this wiki decided since.': 'zeigt, was dieses Wiki seitdem entschieden hat.',
  'warning(s),': 'Warnung(en),',
  'will see search results and links from those wikis.': 'werden Suchergebnisse und Links aus diesen Wikis angezeigt.',
  '· default': '· Standard',
  '— approving now fails with': '– Die Genehmigung schlägt jetzt fehl',
  '— carrying': '– Tragen',
  '— readers of': '— Leser von',
  '— with the one chosen above, in force on their very next request.':
    '– mit der oben gewählten, die bei ihrer nächsten Anfrage in Kraft tritt.',
  '”. It becomes part of the wiki only when a reviewer holding knowledge:approve approves it.':
    'Es wird nur dann Teil des Wikis, wenn ein Prüfer, der über Knowledge:Approve verfügt, es genehmigt.',
} as const satisfies Readonly<Record<string, string>>

export function translateText(
  locale: Locale,
  source: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  const leading = source.match(/^\s*/)?.[0] ?? ''
  const trailing = source.match(/\s*$/)?.[0] ?? ''
  const phrase = source.slice(leading.length, source.length - trailing.length)
  if (locale === 'de') {
    const count = phrase.match(/^(\d+) (claim|claims|source|sources|page|pages)$/)
    if (count) {
      const amount = Number(count[1])
      const noun = count[2]?.startsWith('claim')
        ? amount === 1
          ? 'Aussage'
          : 'Aussagen'
        : count[2]?.startsWith('source')
          ? amount === 1
            ? 'Quelle'
            : 'Quellen'
          : amount === 1
            ? 'Seite'
            : 'Seiten'
      return `${leading}${amount} ${noun}${trailing}`
    }
    const uncited = phrase.match(/^(\d+) uncited$/)
    if (uncited) return `${leading}${uncited[1]} ohne Nachweis${trailing}`
    const withheld = phrase.match(/^(\d+) claims? not counted$/)
    if (withheld)
      return `${leading}${withheld[1]} nicht gezählte ${Number(withheld[1]) === 1 ? 'Aussage' : 'Aussagen'}${trailing}`
    const quotes = phrase.match(/^(\d+) quotes cited$/)
    if (quotes) return `${leading}${quotes[1]} verwendete Zitate${trailing}`
    const decisions = phrase.match(/^(\d+) decided$/)
    if (decisions) return `${leading}${decisions[1]} entschieden${trailing}`
    const submitted = phrase.match(/^(\d+) submitted · (\d+) rejected$/)
    if (submitted) return `${leading}${submitted[1]} eingereicht · ${submitted[2]} abgelehnt${trailing}`
    const pageShare = phrase.match(/^(\d+) of (\d+) pages$/)
    if (pageShare) return `${leading}${pageShare[1]} von ${pageShare[2]} Seiten${trailing}`
    const openNow = phrase.match(/^(\d+) open now$/)
    if (openNow) return `${leading}${openNow[1]} derzeit offen${trailing}`
    const lastHours = phrase.match(/^In the last (\d+) hours\.$/)
    if (lastHours) return `${leading}In den letzten ${lastHours[1]} Stunden.${trailing}`
    const lastDays = phrase.match(/^In the last (\d+) days\.$/)
    if (lastDays) return `${leading}In den letzten ${lastDays[1]} Tagen.${trailing}`
    if (phrase === 'none open') return `${leading}keine offen${trailing}`
    if (phrase === '— each') return `${leading}— je Auftrag${trailing}`
  }
  const template = locale === 'de' ? (DE_PHRASES[phrase as keyof typeof DE_PHRASES] ?? phrase) : phrase
  return `${leading}${interpolate(template, values)}${trailing}`
}

export function interpolate(template: string, values: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`))
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  return interpolate(CATALOGS[locale][key], values)
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value)
}

export function formatDateTime(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf())
    ? '—'
    : new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
