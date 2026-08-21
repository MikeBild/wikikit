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
  'nav.inbox': 'Inbox',
  'nav.pages': 'Pages',
  'nav.answers': 'Answers',
  'nav.care': 'Check',
  'nav.sources': 'Sources',
  'nav.decisions': 'Decisions',
  'nav.decisionLog': 'Decision log',
  'nav.search': 'Search',
  // "Guidelines" in the interface, `charter` in every route, tool, table and
  // doc anchor a machine reads — renaming the API would break contracts for no
  // gain, so the rename stops at the words on screen.
  'nav.charter': 'Guidelines',
  'nav.spaces': 'Wikis',
  'nav.apiKeys': 'API keys',
  'nav.identities': 'People',
  'nav.webhooks': 'Webhooks',
  'nav.modelUsage': 'Model usage',
  'nav.system': 'System',
  // §6 puts an "Audit" entry in every product's Installation block. The word is
  // the same in both catalogs on purpose — it is the family's term, not a
  // translation, and test/unit/cockpit-i18n.test.ts carries it as technical.
  'nav.audit': 'Audit',
  'nav.group.home': 'Home',
  'nav.group.wiki': 'Wiki',
  'nav.group.archive': 'Archive & control',
  'nav.group.installation': 'Installation',
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
  'page.home.description': 'Search all visible wikis and handle work that needs a person.',
  'page.wikiContext': 'Wiki: {name}',
  'page.wikiChange': 'Change wiki',
  'page.inbox.description':
    'Everything lands here: drop documents, paste addresses, and watch what still needs a decision.',
  'page.pages.description': 'Published knowledge, its history and proposed edits.',
  'page.answers.description':
    'Answers and operational reports this wiki has produced. Only answers can become a reviewed knowledge proposal.',
  'page.care.description': 'Read this wiki without changing it, then work through the findings.',
  'page.sources.description': 'Documents and streams that provide evidence for this wiki.',
  'page.decisions.description': 'Everything that is waiting for a person.',
  'page.decisionLog.description': 'Recorded decisions and the evidence behind them.',
  'page.search.description': 'Search every visible wiki or narrow the search to the selected wiki.',
  'page.charter.description': 'The rules that define what belongs in this wiki.',
  'page.spaces.description': 'Available wikis and their operational settings.',
  'page.apiKeys.description': 'Machine credentials and their effective permissions.',
  'page.identities.description': 'People who can sign in and their permission ceilings.',
  'page.webhooks.description': 'Destinations that receive WikiKit events.',
  'page.modelUsage.description': 'Measured model tokens, configured cost and cache use over time.',
  'page.system.description':
    'Which build is serving, whether it is taking traffic, and what the endpoints have been doing.',
  'page.audit.description': 'What happened in this wiki, in the order it happened.',
  'root.listError': 'Could not list wikis',
  'root.listErrorDescription': 'The wikis endpoint did not answer.',
  'root.emptyTitle': 'No wikis yet',
  'root.emptyDescription': 'Create a wiki to store pages, their sources and changes waiting for review.',
  'home.incident.title': 'Open decisions: {total}',
  'home.incident.aging': '{count} of {total} have been waiting longer than three days',
  'home.incident.agingAll': 'All {total} have been waiting longer than three days',
  'home.incident.agingCapped': 'at least {count} of {total} have been waiting longer than three days',
  'home.incident.blocking': '{count} of {total} are blocked',
  'home.incident.overdue': '{count} of {total} missed their deadline',
  'home.incident.open': 'Nothing has been waiting longer than three days.',
  'home.incident.link': 'Open decisions',
  'home.compact.searchPlaceholder': 'Search knowledge in all wikis…',
  'home.compact.searchAction': 'Search',
  'home.compact.tasks': 'Open tasks',
  'home.zoneA.title': 'Waiting for you',
  'home.compact.taskCount': '{count} open',
  'home.compact.taskOldest': 'oldest {days} days',
  'home.compact.taskUndated': 'no dated task',
  'home.compact.tasksError': 'Open tasks could not be loaded',
  'home.compact.tasksEmpty': 'Nothing needs your decision.',
  'home.compact.columnWiki': 'Wiki',
  'home.compact.columnTask': 'Task',
  'home.compact.columnType': 'Type',
  'home.compact.columnWaiting': 'Waiting since',
  'home.compact.columnAction': 'Action',
  'home.compact.reviewProposal': 'Review proposal',
  'home.compact.triageInbox': 'Sort inbox',
  'home.compact.typeProposal': 'Proposal',
  'home.compact.typeTriage': 'Inbox',
  'home.zoneA.openTile': 'open',
  'home.zoneC.label': 'What happened recently →',
  'home.zoneC.link': 'Audit trail',
  'search.scopeAllInput': 'Search all wikis',
  'search.scopeWikiInput': 'Search this wiki',
  'search.scopeAllTitle': 'Search all wikis',
  'search.scopeWikiTitle': 'Search this wiki',
  'search.scopeAllDescription':
    'Search approved knowledge or include archived source evidence from every visible wiki.',
  'search.scopeWikiDescription': 'Search approved knowledge or include archived source evidence from this wiki.',
  'time.today': 'today',
  'time.oneDay': '1 day',
  'time.days': '{count} days',
  'attention.state.open': 'Open',
  'attention.kind.all': 'Everything',
  'attention.kind.proposal': 'Proposal',
  'attention.kind.triage': 'Sort inbox',
  'attention.openCount': '{count} open',
  'attention.oldest': 'Oldest open item: {count} days',
  'attention.noAge': 'No dated work is waiting',
  'attention.effect.proposal': 'Wiki knowledge changes only after a person approves it.',
  'attention.effect.triage': 'Choose where this inbox item belongs.',
  'summary.concept': '{count} concept',
  'summary.concepts': '{count} concepts',
  'summary.claim': '{count} claim',
  'summary.claims': '{count} claims',
  'summary.contradiction': '{count} contradiction found',
  'summary.contradictions': '{count} contradictions found',
  'summary.supersession': '{count} statement replaced',
  'summary.supersessions': '{count} statements replaced',
  'summary.decision': '{count} decision',
  'summary.decisions': '{count} decisions',
  'summary.duplicate': '{count} decision already on record',
  'summary.duplicates': '{count} decisions already on record',
  'summary.update': '{count} updated decision',
  'summary.updates': '{count} updated decisions',
  'summary.original': 'Summary as it arrived',
  'audit.column.when': 'Time',
  'audit.column.subject': 'Event',
  'audit.column.kind': 'Kind',
  'audit.column.outcome': 'Outcome',
  'audit.column.actor': 'Caused by',
  'audit.kind.decision': 'Decision',
  'audit.kind.run': 'Agent run',
  'audit.kind.revision': 'Page revision',
  'audit.kind.guideline': 'Guidelines',
  'audit.subject.decision': 'Change without a title',
  'audit.subject.run': 'Ingest run',
  'audit.subject.revision': 'Page without a title',
  'audit.subject.guideline': "This wiki's guidelines",
  'audit.outcome.approved': 'Approved',
  'audit.outcome.rejected': 'Rejected',
  'audit.outcome.changesRequested': 'Changes requested',
  'audit.outcome.split': 'Split up',
  'audit.outcome.failed': 'Failed',
  'audit.outcome.done': 'Completed',
  'audit.outcome.discarded': 'Discarded',
  'audit.outcome.revision': 'Revision {rev}',
  'audit.outcome.guideline': 'Version {rev}',
  'audit.outcome.guidelineCurrent': 'Version {rev}, in force',
  'audit.source.proposals': 'decisions',
  'audit.source.ingests': 'agent runs',
  'audit.source.concepts': 'page revisions',
  'audit.source.charter': 'guidelines',
  'audit.scope': '{count} entries · at most {limit} rows per record',
  'audit.footnote':
    'Outside this log: reads and searches, sign-ins, changes to keys and permissions, webhook deliveries. Of the pages only the current revision of each is listed — earlier ones stand in the history of the page itself. A cause is named only where the record carries one.',
  'audit.unreadableTitle': 'One record could not be read',
  'audit.unreadableDescription': 'Missing from this log: {sources}.',
  'audit.empty.title': 'Nothing recorded yet',
  'audit.empty.description':
    'As soon as a change has been decided, a run has finished or a page has been written, it stands here.',
  'decisions.untitled': 'Knowledge change without a title',
  'decisions.rawTitle': 'Title as it arrived',
  'decisions.filters': 'Decision filters',
  'decisions.wikiFilter': 'Filter by wiki',
  'decisions.wikiAll': 'All wikis',
  'decisions.needsAttention': 'Needs attention',
  'decisions.waitingLonger': 'Waiting longer',
  'decisions.loading': 'Loading decisions…',
  'decisions.error': 'Decisions could not be loaded',
  'decisions.empty.filtered': 'Nothing matches these filters',
  'decisions.empty.open': 'Nothing needs a decision',
  'decisions.empty.description': 'Choose another filter or add something to the inbox.',
  'decisions.showAll': 'Show everything',
  'decisions.openInbox': 'Open inbox',
  'decisions.remind': 'Remind in 3 days',
  'decisions.remove': 'Remove from task list',
  'decisions.more': 'More actions',
  'decisions.openObject': 'Open',
  'decisions.openSource': 'View source',
  'decisions.openPage': 'Open page',
  'decisions.openProposal': 'Review proposal',
  'decisions.openGuidelines': 'Open guidelines',
  'decisions.openCheck': 'Open check result',
  'decisions.sortAbove': 'Sort above',
  'decisions.removeConfirmTitle': 'Remove this task?',
  'decisions.removeConfirmDescription':
    'It leaves the open task list. What happened to it stays in the audit trail; this page shows only what is still waiting.',
  'decisions.origin': 'Comes from',
  'decisions.target': 'Should change',
  'decisions.generated': 'Generated report',
  'decisions.noOrigin': 'No source named',
  'decisions.noTarget': 'Target not chosen yet',
  'decisions.target.create': 'New page',
  'decisions.target.update': 'Change page',
  'decisions.target.choose': 'Choose target',
  'decisions.showEvidence': 'Show change and evidence',
  'decisions.hideEvidence': 'Hide change and evidence',
  'decisions.previousRejection': 'An identical proposal was rejected before',
  'decisions.previousRejectionNoNote': 'The previous review did not include a note.',
  'decisions.loadingDiff': 'Loading change…',
  'decisions.before': 'Before',
  'decisions.after': 'After',
  'decisions.newPage': 'New page',
  'decisions.sourceLocked': 'Source locked',
  'decisions.checkSummary': 'Check: {errors} errors, {warnings} warnings',
  'decisions.triage.preparing': 'Preparing a sorting suggestion…',
  'decisions.triage.unavailable': 'No sorting suggestion is available',
  'decisions.triage.title': 'Title',
  'decisions.triage.target': 'Target wiki',
  'decisions.triage.summary': 'Summary',
  'decisions.triage.question': 'Question to keep open',
  'decisions.triage.process': 'Process here',
  'decisions.triage.useExisting': 'Use existing source',
  'decisions.triage.leave': 'Leave open',
  'decisions.triage.discard': 'Discard capture',
  'check.run': 'Check wiki',
  'check.idle.title': 'Check this wiki',
  'check.idle.description': 'The check reads pages, claims and sources. It changes nothing.',
  'check.loading': 'Checking the wiki…',
  'check.result': 'Check result',
  'check.checked': 'Checked',
  'check.guidelinesRevision': 'Guidelines revision',
  'check.foundAt': 'Checked {time}',
  'check.findings': 'Work through findings',
  'check.reports': 'Check reports',
  'check.schedule': 'Reports and schedule',
  'check.actionRequired': 'Action needed',
  'check.actionRequired.description': 'These findings name a concrete problem and where to continue.',
  'check.information': 'Information',
  'check.information.description': 'These observations are not decisions and do not count as open work.',
  'check.unusedSource.title': 'Unused source',
  'check.unusedSource.description': 'This source is safely archived but is not currently used by any claim.',
  'check.unusedSource.noAction':
    'This is not an error. If it was archived only as evidence, you do not need to do anything.',
  'check.proposeKnowledge': 'Propose knowledge',
  'check.viewSource': 'View source',
  'check.resynthesize.title': 'Propose knowledge from this source?',
  'check.resynthesize.description':
    'The archived source is read again by the current pipeline. The wiki changes only if a person later approves the resulting proposal.',
  'check.resynthesize.confirm': 'Create proposal',
  'check.resynthesize.running': 'Preparing proposal…',
  'check.resynthesize.done': 'The proposal is ready for review.',
  'check.resynthesize.noChange': 'The source produced no new proposal.',
  'check.resynthesize.failed': 'The source could not be processed.',
  'check.openProposal': 'Review proposal',
  'spaces.description': 'All knowledge areas and what currently needs a decision.',
  'spaces.openWiki': 'Open wiki',
  'spaces.moreActions': 'More wiki actions',
  'spaces.exportMarkdown': 'Export Markdown',
  'spaces.exportMarkdownHelp': 'Readable files for pages, decisions and sources.',
  'spaces.exportOkf': 'Export Open Knowledge Format',
  'spaces.exportOkfHelp': 'Structured claims, citations and relations.',
  'spaces.settings': 'Settings',
  'spaces.settingsAdmin': 'Administrator permission required.',
  'spaces.delete': 'Delete wiki',
  'spaces.deleteTitle': 'Permanently delete wiki?',
  'spaces.deleteDescription':
    'This permanently deletes {slug}, including every page, source, proposal, key and webhook. It cannot be undone.',
  'spaces.deleteConfirm': 'Type {slug} to confirm.',
  'spaces.deleteFailed': 'The wiki could not be deleted',
  'spaces.deleteDone': 'Wiki {slug} deleted',
  'spaces.overviewTitle': 'Across every wiki',
  'spaces.openDecisions': 'Open decisions',
  'spaces.current': 'Selected',
  'spaces.wikisWithOpen': 'Wikis with open decisions',
  'spaces.visibleWikis': 'Visible wikis',
  'spaces.oldest': 'The oldest has waited',
  'outputs.status.report': 'Report',
  'outputs.status.proposed': 'Knowledge proposed',
  'outputs.status.saved': 'Saved answer',
  'answer.report.title': 'This is a report, not a knowledge proposal',
  'answer.report.description':
    'It records one scheduled run and stays in the report history. Use Decisions for the actual work it names.',
  'answer.report.openDecisions': 'Open decisions',
  'answer.propose.title': 'Propose knowledge from this answer',
  'answer.propose.description':
    'The answer is archived as a generated source and processed into a review proposal. Visible knowledge changes only after approval.',
  'answer.propose.confirmTitle': 'Propose knowledge from this answer?',
  'answer.propose.confirmDescription': 'Archive the answer and create a change for human review.',
  'answer.propose.action': 'Propose knowledge',
  'answer.propose.permission': 'Needs knowledge:propose — this action creates a change for review.',
  'answer.propose.success': 'Knowledge proposed — the change is waiting for review',
  'answer.propose.outcome': 'Proposed as a knowledge change',
  'answer.propose.review': 'Review the change',
  'source.references.title': 'Used by',
  'source.references.description': 'Current pages and pending proposals that use this archived source.',
  'source.references.empty': 'No page or pending proposal uses this source.',
  'source.references.error': 'References could not be loaded.',
  'source.references.page': 'Current page',
  'source.references.proposal': 'Pending proposal',
  'source.title': 'Source',
  'source.description': "Archived verbatim and read-only — this is what the wiki's claims quote.",
  'source.missing.title': 'No source named',
  'source.missing.description': 'This address is missing a source id. Open a source from the archive.',
  'pages.empty.filtered.one': 'This wiki has {count} page loaded; none changed {window}.',
  'pages.empty.filtered.many': 'This wiki has {count} pages loaded; none changed {window}.',
  'system.tab.overview': 'Overview',
  'system.tab.knowledge': 'Knowledge',
  'system.tab.activity': 'Activity',
  'modelUsage.current.title': 'This wiki',
  'modelUsage.current.description': 'Measured model work for the selected wiki during the server-reported window.',
  'modelUsage.all.title': 'Across all wikis',
  'modelUsage.all.description': 'Installation-wide totals require administrator permission.',
  'modelUsage.all.empty.title': 'No model usage recorded',
  'modelUsage.all.empty.description': 'No visible wiki has recorded a model call during this window.',
  'modelUsage.calls': 'Calls',
  'modelUsage.calls.value': '{count} calls',
  'modelUsage.tokens': 'Tokens',
  'modelUsage.tokens.hint': '{input} input · {output} output',
  'modelUsage.cost': 'Known cost',
  'modelUsage.cost.hint': 'USD from configured prices only',
  'modelUsage.cache': 'Cache reads',
  'modelUsage.cache.hint': 'Share of input read from cache',
  'modelUsage.unpriced.title': 'Part of this usage has no configured price',
  'modelUsage.unpriced.description': '{calls} calls and {tokens} tokens are not included in cost. Models: {models}.',
  'modelUsage.chart.tokens': 'Tokens',
  'modelUsage.chart.cost': 'Cost',
  'modelUsage.chart.tokensLabel': 'Measured input, output and cached input tokens over time',
  'modelUsage.chart.costLabel': 'Known configured cost and unpriced calls over time',
  'modelUsage.chart.input': 'Input',
  'modelUsage.chart.output': 'Output',
  'modelUsage.chart.cache': 'Cache read',
  'modelUsage.chart.knownCost': 'Known cost',
  'modelUsage.chart.unpriced': 'Unpriced calls',
  'modelUsage.bucket.hour': 'Hourly',
  'modelUsage.bucket.day': 'Daily',
  'modelUsage.bucket.month': 'Monthly',
  'modelUsage.bucket.year': 'Yearly',
  'modelUsage.window': '{bucket} values · {from} to {to}',
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
  'nav.inbox': 'Eingang',
  'nav.pages': 'Seiten',
  'nav.answers': 'Antworten',
  'nav.care': 'Prüfen',
  'nav.sources': 'Quellen',
  'nav.decisions': 'Entscheidungen',
  'nav.decisionLog': 'Entscheidungsprotokoll',
  'nav.search': 'Suche',
  'nav.charter': 'Leitlinien',
  'nav.spaces': 'Wikis',
  'nav.apiKeys': 'API-Schlüssel',
  'nav.identities': 'Personen',
  'nav.webhooks': 'Webhooks',
  'nav.modelUsage': 'Modellnutzung',
  'nav.system': 'System',
  'nav.audit': 'Audit',
  'nav.group.home': 'Start',
  'nav.group.wiki': 'Wiki',
  'nav.group.archive': 'Archiv & Steuerung',
  'nav.group.installation': 'Installation',
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
  'page.home.description': 'Alle sichtbaren Wikis durchsuchen und Aufgaben bearbeiten, die einen Menschen brauchen.',
  'page.wikiContext': 'Wiki: {name}',
  'page.wikiChange': 'Wiki wechseln',
  'page.inbox.description':
    'Hier landet alles: Dokumente ablegen, Adressen einfügen und verfolgen, was noch eine Entscheidung braucht.',
  'page.pages.description': 'Veröffentlichtes Wissen, sein Verlauf und vorgeschlagene Änderungen.',
  'page.answers.description':
    'Antworten und Betriebsberichte dieses Wikis. Nur aus Antworten kann ein geprüfter Wissensvorschlag entstehen.',
  'page.care.description': 'Dieses Wiki lesen, ohne etwas zu ändern, und anschließend die Befunde bearbeiten.',
  'page.sources.description': 'Dokumente und Datenströme, die Nachweise für dieses Wiki liefern.',
  'page.decisions.description': 'Alles, was auf einen Menschen wartet.',
  'page.decisionLog.description': 'Dokumentierte Entscheidungen und die zugehörigen Nachweise.',
  'page.search.description': 'Alle sichtbaren Wikis durchsuchen oder die Suche auf das ausgewählte Wiki begrenzen.',
  'page.charter.description': 'Die Regeln dafür, was in dieses Wiki gehört.',
  'page.spaces.description': 'Verfügbare Wikis und ihre betrieblichen Einstellungen.',
  'page.apiKeys.description': 'Maschinenzugänge und ihre wirksamen Berechtigungen.',
  'page.identities.description': 'Personen mit Zugang und ihre Berechtigungsgrenzen.',
  'page.webhooks.description': 'Ziele, die WikiKit-Ereignisse empfangen.',
  'page.modelUsage.description': 'Gemessene Modell-Tokens, konfigurierte Kosten und Cache-Nutzung im Zeitverlauf.',
  'page.system.description': 'Ausgelieferter Build, Bereitschaft und Endpunktaktivität.',
  'page.audit.description': 'Was in diesem Wiki geschehen ist, in der Reihenfolge des Geschehens.',
  'root.listError': 'Wikis konnten nicht geladen werden',
  'root.listErrorDescription': 'Der Wikis-Endpunkt hat nicht geantwortet.',
  'root.emptyTitle': 'Noch keine Wikis',
  'root.emptyDescription':
    'Ein Wiki speichert Seiten, ihre Quellen und Änderungen zur Prüfung. Das erste Wiki wird über die API angelegt.',
  'home.incident.title': 'Offene Entscheidungen: {total}',
  'home.incident.aging': '{count} von {total} warten länger als drei Tage',
  'home.incident.agingAll': 'Alle {total} warten länger als drei Tage',
  'home.incident.agingCapped': 'mindestens {count} von {total} warten länger als drei Tage',
  'home.incident.blocking': '{count} von {total} sind blockiert',
  'home.incident.overdue': '{count} von {total} haben ihre Frist gerissen',
  'home.incident.open': 'Nichts liegt länger als drei Tage.',
  'home.incident.link': 'Entscheidungen öffnen',
  'home.compact.searchPlaceholder': 'Wissen in allen Wikis durchsuchen…',
  'home.compact.searchAction': 'Suchen',
  'home.compact.tasks': 'Offene Aufgaben',
  'home.zoneA.title': 'Wartet auf dich',
  'home.compact.taskCount': '{count} offen',
  'home.compact.taskOldest': 'älteste {days} Tage',
  'home.compact.taskUndated': 'keine datierte Aufgabe',
  'home.compact.tasksError': 'Offene Aufgaben konnten nicht geladen werden',
  'home.compact.tasksEmpty': 'Nichts braucht deine Entscheidung.',
  'home.compact.columnWiki': 'Wiki',
  'home.compact.columnTask': 'Aufgabe',
  'home.compact.columnType': 'Typ',
  'home.compact.columnWaiting': 'Wartet seit',
  'home.compact.columnAction': 'Aktion',
  'home.compact.reviewProposal': 'Vorschlag prüfen',
  'home.compact.triageInbox': 'Eingang einordnen',
  'home.compact.typeProposal': 'Vorschlag',
  'home.compact.typeTriage': 'Eingang',
  'home.zoneA.openTile': 'offen',
  'home.zoneC.label': 'Was zuletzt geschah →',
  'home.zoneC.link': 'Audit-Trail',
  'search.scopeAllInput': 'Alle Wikis durchsuchen',
  'search.scopeWikiInput': 'Dieses Wiki durchsuchen',
  'search.scopeAllTitle': 'Alle Wikis durchsuchen',
  'search.scopeWikiTitle': 'Dieses Wiki durchsuchen',
  'search.scopeAllDescription': 'Freigegebenes Wissen oder archivierte Quellen in allen sichtbaren Wikis durchsuchen.',
  'search.scopeWikiDescription': 'Freigegebenes Wissen oder archivierte Quellen in diesem Wiki durchsuchen.',
  'time.today': 'heute',
  'time.oneDay': '1 Tag',
  'time.days': '{count} Tage',
  'attention.state.open': 'Offen',
  'attention.kind.all': 'Alles',
  'attention.kind.proposal': 'Vorschlag',
  'attention.kind.triage': 'Eingang einordnen',
  'attention.openCount': '{count} offen',
  'attention.oldest': 'Ältester offener Eintrag: {count} Tage',
  'attention.noAge': 'Keine datierte Aufgabe wartet',
  'attention.effect.proposal': 'Das Wiki-Wissen ändert sich erst nach menschlicher Freigabe.',
  'attention.effect.triage': 'Hier wird entschieden, wohin dieser Eingangseintrag gehört.',
  'summary.concept': '{count} Konzept',
  'summary.concepts': '{count} Konzepte',
  'summary.claim': '{count} Aussage',
  'summary.claims': '{count} Aussagen',
  'summary.contradiction': '{count} Widerspruch gefunden',
  'summary.contradictions': '{count} Widersprüche gefunden',
  'summary.supersession': '{count} Aussage abgelöst',
  'summary.supersessions': '{count} Aussagen abgelöst',
  'summary.decision': '{count} Entscheidung',
  'summary.decisions': '{count} Entscheidungen',
  'summary.duplicate': '{count} Entscheidung bereits erfasst',
  'summary.duplicates': '{count} Entscheidungen bereits erfasst',
  'summary.update': '{count} aktualisierte Entscheidung',
  'summary.updates': '{count} aktualisierte Entscheidungen',
  'summary.original': 'Zusammenfassung, wie sie ankam',
  'audit.column.when': 'Zeitpunkt',
  'audit.column.subject': 'Vorgang',
  'audit.column.kind': 'Art',
  'audit.column.outcome': 'Ergebnis',
  'audit.column.actor': 'Verursacher',
  'audit.kind.decision': 'Entscheidung',
  'audit.kind.run': 'Agentenlauf',
  'audit.kind.revision': 'Seitenrevision',
  'audit.kind.guideline': 'Leitlinien',
  'audit.subject.decision': 'Änderung ohne Titel',
  'audit.subject.run': 'Aufnahmelauf',
  'audit.subject.revision': 'Seite ohne Titel',
  'audit.subject.guideline': 'Leitlinien dieses Wikis',
  'audit.outcome.approved': 'Freigegeben',
  'audit.outcome.rejected': 'Abgelehnt',
  'audit.outcome.changesRequested': 'Änderung angefordert',
  'audit.outcome.split': 'Aufgeteilt',
  'audit.outcome.failed': 'Fehlgeschlagen',
  'audit.outcome.done': 'Abgeschlossen',
  'audit.outcome.discarded': 'Verworfen',
  'audit.outcome.revision': 'Fassung {rev}',
  'audit.outcome.guideline': 'Fassung {rev}',
  'audit.outcome.guidelineCurrent': 'Fassung {rev}, in Kraft',
  'audit.source.proposals': 'Entscheidungen',
  'audit.source.ingests': 'Agentenläufe',
  'audit.source.concepts': 'Seitenrevisionen',
  'audit.source.charter': 'Leitlinien',
  'audit.scope': '{count} Einträge · höchstens {limit} Zeilen je Quelle',
  'audit.footnote':
    'Nicht in diesem Protokoll: Lesezugriffe und Suchen, Anmeldungen, Änderungen an Schlüsseln und Rechten, Webhook-Zustellungen. Von den Seiten steht je nur die aktuelle Fassung hier — frühere stehen in der Historie der Seite selbst. Ein Verursacher wird nur dort genannt, wo die Quelle einen führt.',
  'audit.unreadableTitle': 'Eine Quelle war nicht lesbar',
  'audit.unreadableDescription': 'In diesem Protokoll fehlen: {sources}.',
  'audit.empty.title': 'Noch nichts aufgezeichnet',
  'audit.empty.description':
    'Sobald eine Änderung entschieden, ein Lauf beendet oder eine Seite geschrieben wurde, steht sie hier.',
  'decisions.untitled': 'Wissensänderung ohne Titel',
  'decisions.rawTitle': 'Titel, wie er ankam',
  'decisions.filters': 'Entscheidungsfilter',
  'decisions.wikiFilter': 'Nach Wiki filtern',
  'decisions.wikiAll': 'Alle Wikis',
  'decisions.needsAttention': 'Braucht eine Entscheidung',
  'decisions.waitingLonger': 'Liegt schon länger',
  'decisions.loading': 'Entscheidungen werden geladen…',
  'decisions.error': 'Entscheidungen konnten nicht geladen werden',
  'decisions.empty.filtered': 'Nichts passt zu diesen Filtern',
  'decisions.empty.open': 'Keine Entscheidung ist offen',
  'decisions.empty.description': 'Ein anderer Filter zeigt weitere Einträge; neue Aufgaben entstehen im Eingang.',
  'decisions.showAll': 'Alles anzeigen',
  'decisions.openInbox': 'Eingang öffnen',
  'decisions.remind': 'In 3 Tagen erinnern',
  'decisions.remove': 'Aus der Aufgabenliste entfernen',
  'decisions.more': 'Weitere Aktionen',
  'decisions.openObject': 'Öffnen',
  'decisions.openSource': 'Quelle ansehen',
  'decisions.openPage': 'Seite öffnen',
  'decisions.openProposal': 'Vorschlag prüfen',
  'decisions.openGuidelines': 'Leitlinien öffnen',
  'decisions.openCheck': 'Prüfergebnis öffnen',
  'decisions.sortAbove': 'Oben einordnen',
  'decisions.removeConfirmTitle': 'Diese Aufgabe entfernen?',
  'decisions.removeConfirmDescription':
    'Der Eintrag verlässt die offene Aufgabenliste. Was mit ihm geschah, bleibt im Audit-Trail; diese Seite zeigt nur, was noch wartet.',
  'decisions.origin': 'Kommt aus',
  'decisions.target': 'Soll ändern',
  'decisions.generated': 'Generierter Bericht',
  'decisions.noOrigin': 'Keine Quelle genannt',
  'decisions.noTarget': 'Ziel noch nicht festgelegt',
  'decisions.target.create': 'Neue Seite',
  'decisions.target.update': 'Seite ändern',
  'decisions.target.choose': 'Ziel festlegen',
  'decisions.showEvidence': 'Änderung und Belege ansehen',
  'decisions.hideEvidence': 'Änderung und Belege ausblenden',
  'decisions.previousRejection': 'Ein inhaltlich gleicher Vorschlag wurde schon einmal abgelehnt',
  'decisions.previousRejectionNoNote': 'Die frühere Prüfung enthält keine Begründung.',
  'decisions.loadingDiff': 'Änderung wird geladen…',
  'decisions.before': 'Vorher',
  'decisions.after': 'Nachher',
  'decisions.newPage': 'Neue Seite',
  'decisions.sourceLocked': 'Quelle unveränderbar',
  'decisions.checkSummary': 'Prüfung: {errors} Fehler, {warnings} Warnungen',
  'decisions.triage.preparing': 'Vorschlag zum Einordnen wird vorbereitet…',
  'decisions.triage.unavailable': 'Es ist kein Vorschlag zum Einordnen verfügbar',
  'decisions.triage.title': 'Titel',
  'decisions.triage.target': 'Ziel-Wiki',
  'decisions.triage.summary': 'Zusammenfassung',
  'decisions.triage.question': 'Offene Frage',
  'decisions.triage.process': 'Hier verarbeiten',
  'decisions.triage.useExisting': 'Vorhandene Quelle verwenden',
  'decisions.triage.leave': 'Offen lassen',
  'decisions.triage.discard': 'Eingangseintrag verwerfen',
  'check.run': 'Wiki prüfen',
  'check.idle.title': 'Dieses Wiki prüfen',
  'check.idle.description': 'Die Prüfung liest Seiten, Aussagen und Quellen. Dabei wird nichts geändert.',
  'check.loading': 'Wiki wird geprüft…',
  'check.result': 'Prüfergebnis',
  'check.checked': 'Geprüft',
  'check.guidelinesRevision': 'Leitlinien, Stand',
  'check.foundAt': 'Geprüft {time}',
  'check.findings': 'Befunde bearbeiten',
  'check.reports': 'Prüfberichte',
  'check.schedule': 'Prüfberichte und Zeitplan',
  'check.actionRequired': 'Handlung nötig',
  'check.actionRequired.description': 'Diese Befunde nennen ein konkretes Problem und den passenden nächsten Schritt.',
  'check.information': 'Hinweise',
  'check.information.description': 'Diese Beobachtungen sind keine Entscheidungen und zählen nicht als offene Arbeit.',
  'check.unusedSource.title': 'Ungenutzte Quelle',
  'check.unusedSource.description':
    'Diese Quelle ist sicher archiviert, wird aber derzeit von keiner Aussage verwendet.',
  'check.unusedSource.noAction': 'Das ist kein Fehler. Bei einer nur als Beleg archivierten Quelle ist nichts zu tun.',
  'check.proposeKnowledge': 'Wissen vorschlagen',
  'check.viewSource': 'Quelle ansehen',
  'check.resynthesize.title': 'Aus dieser Quelle Wissen vorschlagen?',
  'check.resynthesize.description':
    'Die archivierte Quelle wird mit der aktuellen Verarbeitung erneut gelesen. Das Wiki ändert sich erst, wenn ein Mensch den entstandenen Vorschlag später freigibt.',
  'check.resynthesize.confirm': 'Vorschlag erstellen',
  'check.resynthesize.running': 'Vorschlag wird vorbereitet…',
  'check.resynthesize.done': 'Der Vorschlag kann jetzt geprüft werden.',
  'check.resynthesize.noChange': 'Aus der Quelle ist kein neuer Vorschlag entstanden.',
  'check.resynthesize.failed': 'Die Quelle konnte nicht verarbeitet werden.',
  'check.openProposal': 'Vorschlag prüfen',
  'spaces.description': 'Alle Wissensbereiche und was dort gerade eine Entscheidung braucht.',
  'spaces.openWiki': 'Wiki öffnen',
  'spaces.moreActions': 'Weitere Wiki-Aktionen',
  'spaces.exportMarkdown': 'Markdown exportieren',
  'spaces.exportMarkdownHelp': 'Lesbare Dateien für Seiten, Entscheidungen und Quellen.',
  'spaces.exportOkf': 'Open Knowledge Format exportieren',
  'spaces.exportOkfHelp': 'Strukturierte Aussagen, Belege und Beziehungen.',
  'spaces.settings': 'Einstellungen',
  'spaces.settingsAdmin': 'Administrator-Berechtigung erforderlich.',
  'spaces.delete': 'Wiki löschen',
  'spaces.deleteTitle': 'Wiki endgültig löschen?',
  'spaces.deleteDescription':
    '{slug} wird mit allen Seiten, Quellen, Vorschlägen, Schlüsseln und Webhooks endgültig gelöscht. Das lässt sich nicht rückgängig machen.',
  'spaces.deleteConfirm': 'Zur Bestätigung {slug} eingeben.',
  'spaces.deleteFailed': 'Das Wiki konnte nicht gelöscht werden',
  'spaces.deleteDone': 'Wiki {slug} gelöscht',
  'spaces.overviewTitle': 'Über alle Wikis',
  'spaces.openDecisions': 'Offene Entscheidungen',
  'spaces.current': 'Ausgewählt',
  'spaces.wikisWithOpen': 'Wikis mit offenen Entscheidungen',
  'spaces.visibleWikis': 'Sichtbare Wikis',
  'spaces.oldest': 'Der älteste Eintrag wartet seit',
  'outputs.status.report': 'Bericht',
  'outputs.status.proposed': 'Wissen vorgeschlagen',
  'outputs.status.saved': 'Gespeicherte Antwort',
  'answer.report.title': 'Das ist ein Bericht, kein Wissensvorschlag',
  'answer.report.description':
    'Er dokumentiert einen geplanten Lauf und bleibt im Berichtsverlauf. Die darin genannte Arbeit findest du unter Entscheidungen.',
  'answer.report.openDecisions': 'Entscheidungen öffnen',
  'answer.propose.title': 'Wissen aus dieser Antwort vorschlagen',
  'answer.propose.description':
    'Die Antwort wird als generierte Quelle archiviert und zu einem prüfbaren Vorschlag verarbeitet. Sichtbares Wissen ändert sich erst nach der Freigabe.',
  'answer.propose.confirmTitle': 'Wissen aus dieser Antwort vorschlagen?',
  'answer.propose.confirmDescription': 'Die Antwort archivieren und eine Änderung zur menschlichen Prüfung erstellen.',
  'answer.propose.action': 'Wissen vorschlagen',
  'answer.propose.permission': 'knowledge:propose erforderlich – diese Aktion erstellt eine Änderung zur Prüfung.',
  'answer.propose.success': 'Wissen vorgeschlagen – die Änderung wartet auf Prüfung',
  'answer.propose.outcome': 'Als Wissensänderung vorgeschlagen',
  'answer.propose.review': 'Änderung prüfen',
  'source.references.title': 'Verwendet in',
  'source.references.description': 'Aktuelle Seiten und offene Vorschläge, die diese archivierte Quelle verwenden.',
  'source.references.empty': 'Keine Seite und kein offener Vorschlag verwendet diese Quelle.',
  'source.references.error': 'Verwendungen konnten nicht geladen werden.',
  'source.references.page': 'Aktuelle Seite',
  'source.references.proposal': 'Offener Vorschlag',
  'source.title': 'Quelle',
  'source.description': 'Unverändert und schreibgeschützt archiviert – diese Quelle wird von Aussagen zitiert.',
  'source.missing.title': 'Keine Quelle angegeben',
  'source.missing.description':
    'In dieser Adresse fehlt die Quellen-ID. Das Quellenarchiv führt zu gültigen Einträgen.',
  'pages.empty.filtered.one': 'Dieses Wiki enthält {count} geladene Seite; sie wurde {window} nicht geändert.',
  'pages.empty.filtered.many': 'Dieses Wiki enthält {count} geladene Seiten; keine davon wurde {window} geändert.',
  'system.tab.overview': 'Übersicht',
  'system.tab.knowledge': 'Wissen',
  'system.tab.activity': 'Aktivität',
  'modelUsage.current.title': 'Dieses Wiki',
  'modelUsage.current.description': 'Gemessene Modellarbeit für das ausgewählte Wiki im angezeigten Zeitraum.',
  'modelUsage.all.title': 'Über alle Wikis',
  'modelUsage.all.description': 'Installationsweite Summen erfordern Administratorrechte.',
  'modelUsage.all.empty.title': 'Keine Modellnutzung erfasst',
  'modelUsage.all.empty.description': 'In diesem Zeitraum wurde in keinem sichtbaren Wiki ein Modell aufgerufen.',
  'modelUsage.calls': 'Aufrufe',
  'modelUsage.calls.value': '{count} Aufrufe',
  'modelUsage.tokens': 'Tokens',
  'modelUsage.tokens.hint': '{input} Eingabe · {output} Ausgabe',
  'modelUsage.cost': 'Bekannte Kosten',
  'modelUsage.cost.hint': 'USD nur aus konfigurierten Preisen',
  'modelUsage.cache': 'Cache-Leseanteil',
  'modelUsage.cache.hint': 'Anteil der Eingabe aus dem Cache',
  'modelUsage.unpriced.title': 'Für einen Teil der Nutzung fehlt ein Preis',
  'modelUsage.unpriced.description':
    '{calls} Aufrufe und {tokens} Tokens sind nicht in den Kosten enthalten. Modelle: {models}.',
  'modelUsage.chart.tokens': 'Tokens',
  'modelUsage.chart.cost': 'Kosten',
  'modelUsage.chart.tokensLabel': 'Gemessene Eingabe-, Ausgabe- und Cache-Tokens im Zeitverlauf',
  'modelUsage.chart.costLabel': 'Bekannte konfigurierte Kosten und Aufrufe ohne Preis im Zeitverlauf',
  'modelUsage.chart.input': 'Eingabe',
  'modelUsage.chart.output': 'Ausgabe',
  'modelUsage.chart.cache': 'Cache',
  'modelUsage.chart.knownCost': 'Bekannte Kosten',
  'modelUsage.chart.unpriced': 'Aufrufe ohne Preis',
  'modelUsage.bucket.hour': 'Stündliche',
  'modelUsage.bucket.day': 'Tägliche',
  'modelUsage.bucket.month': 'Monatliche',
  'modelUsage.bucket.year': 'Jährliche',
  'modelUsage.window': '{bucket} Werte · {from} bis {to}',
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
  'All wikis': 'Alle Wikis',
  'This wiki': 'Dieses Wiki',
  'Find approved knowledge across every wiki or narrow the search to the selected wiki.':
    'Freigegebenes Wissen in allen Wikis finden oder die Suche auf das ausgewählte Wiki begrenzen.',
  'The slug is the stable address every link, API call and export filename will carry. Deleting the wiki later permanently removes all of its data.':
    'Der Slug ist die feste Adresse für Links, API-Aufrufe und Exportdateien. Wird das Wiki später gelöscht, werden alle seine Daten endgültig entfernt.',
  'Where to search': 'Suchbereich',
  'Every wiki this key can see, summed: actual human decisions and how long the oldest has waited. Check findings are observations and are not counted as decisions.':
    'Alle für diesen Zugang sichtbaren Wikis, zusammengefasst: menschliche Entscheidungen und die Wartezeit des ältesten Eintrags. Prüfbefunde sind Beobachtungen und zählen nicht als Entscheidungen.',
  Actions: 'Aktionen',
  Edit: 'Bearbeiten',
  Waiting: 'Wartet',
  'A reminder is overdue': 'Eine Erinnerung ist überfällig',
  After: 'Danach',
  'An identical proposal was rejected before': 'Ein identischer Vorschlag wurde bereits abgelehnt',
  'Attention could not be loaded': 'Die Aufgaben konnten nicht geladen werden',
  // The error surface's whole vocabulary (lib/failure.ts, components/confirm.logic.ts).
  // These titles are composed outside JSX, so the .tsx phrase probe never saw
  // them and every refusal banner read English on a German console.
  'This request was not understood': 'Diese Anfrage wurde nicht verstanden',
  'Not signed in': 'Nicht angemeldet',
  'Not permitted': 'Nicht erlaubt',
  'There is nothing here': 'Hier ist nichts',
  'Not available here': 'Hier nicht verfügbar',
  'This has already moved on': 'Das ist inzwischen weitergelaufen',
  'This is gone': 'Das gibt es nicht mehr',
  'Nothing is bound for this yet': 'Dafür ist noch nichts eingerichtet',
  'This cannot be loaded': 'Das lässt sich nicht laden',
  'Could not load this': 'Konnte nicht geladen werden',
  'Could not load this — trying again': 'Konnte nicht geladen werden — neuer Versuch läuft',
  'The request failed and no message came back.': 'Die Anfrage ist fehlgeschlagen, und es kam keine Meldung zurück.',
  'The server refused': 'Der Server hat abgelehnt',
  'The request failed and the server gave no reason.':
    'Die Anfrage ist fehlgeschlagen, und der Server hat keinen Grund genannt.',
  Before: 'Davor',
  'Check this wiki': 'Dieses Wiki prüfen',
  'Check:': 'Prüfung:',
  Checked: 'Geprüft',
  'Checking changed nothing. Review each finding before any repair enters the knowledge workflow.':
    'Die Prüfung hat nichts verändert. Jeder Befund wird geprüft, bevor eine Reparatur in den Wissensablauf gelangt.',
  'Decision filters': 'Entscheidungen filtern',
  'Decisions could not be loaded': 'Entscheidungen konnten nicht geladen werden',
  'Discard capture': 'Notiz verwerfen',
  'Leave open': 'Offen lassen',
  'Loading decisions…': 'Entscheidungen werden geladen…',
  'Loading diff…': 'Vergleich wird geladen…',
  'Loading…': 'Wird geladen…',
  'Needs attention': 'Aufgabe offen',
  'Needs your attention': 'Aufgaben offen',
  Findings: 'Befunde',
  'No sorting suggestion is available': 'Kein Sortiervorschlag verfügbar',
  'Nothing is waiting.': 'Nichts wartet.',
  'Open Inbox': 'Eingang öffnen',
  'Open decisions': 'Entscheidungen öffnen',
  'Open output': 'Ergebnis öffnen',
  'Open review': 'Prüfung öffnen',
  Overdue: 'Überfällig',
  'Page not found': 'Seite nicht gefunden',
  'Preparing a sorting suggestion…': 'Sortiervorschlag wird vorbereitet…',
  'Process here': 'Hier verarbeiten',
  Proposals: 'Vorschläge',
  'Question to keep open': 'Offene Frage',
  'Remind in 3 days': 'In 3 Tagen erinnern',
  'Remove from queue': 'Aus der Aufgabenliste entfernen',
  'Resolve above': 'Oben entscheiden',
  'Return to open': 'Wieder öffnen',
  'Return to overview': 'Zurück zur Übersicht',
  'Sort capture': 'Notiz einordnen',
  'Source locked': 'Quelle unantastbar',
  'The archived content cannot be changed. A check may update metadata only; corrections arrive as a new source.':
    'Der archivierte Inhalt kann nicht verändert werden. Eine Prüfung darf nur Metadaten aktualisieren; Korrekturen kommen als neue Quelle hinzu.',
  'Target wiki': 'Ziel-Wiki',
  'The page no longer exists': 'Die Seite existiert nicht mehr',
  'This address is not part of the current cockpit.': 'Diese Adresse gehört nicht zum aktuellen Cockpit.',
  'Use existing source': 'Vorhandene Quelle verwenden',
  'Use the current navigation or return to the overview.':
    'Die aktuelle Navigation verwenden oder zur Übersicht zurückkehren.',
  'Nothing matches these filters': 'Nichts passt zu diesen Filtern',
  'What needs a decision': 'Was entschieden werden muss',
  'What you need to decide': 'Was entschieden werden muss',
  'deferred item': 'zurückgestellter Eintrag',
  'errors,': 'Fehler,',
  open: 'offen',
  'overdue ·': 'überfällig ·',
  'reached their reminder time.': 'haben ihren Erinnerungszeitpunkt erreicht.',
  warnings: 'Warnungen',
  '· Guidelines revision': '· Leitlinien-Revision',
  'More information': 'Weitere Informationen',
  'About asking': 'Informationen zur Antwortfunktion',
  'About API key names': 'Informationen zu API-Schlüsselnamen',
  'About charter Markdown': 'Informationen zum Markdown der Leitlinien',
  'About connector streams': 'Informationen zu Connector-Datenströmen',
  'About connector-managed sources': 'Informationen zu Connector-verwalteten Quellen',
  'About identity providers': 'Informationen zu Identitätsanbietern',
  'About identity subjects': 'Informationen zu Identitätssubjekten',
  'About MCP clients': 'Informationen zu MCP-Clients',
  'About reference targets': 'Informationen zu Referenzzielen',
  'About search language': 'Informationen zur Suchsprache',
  'About the archive record': 'Informationen zum Archiveintrag',
  'About the archived document': 'Informationen zum archivierten Dokument',
  'About this build': 'Informationen zu diesem Build',
  'About use-when guidance': 'Informationen zur Verwendungsempfehlung',
  'About the derived overview': 'Informationen zur abgeleiteten Übersicht',
  // Ingest phases — what a running job is doing, so a long wait is legible.
  'Fetching the document': 'Dokument wird geladen',
  'Archiving it verbatim before anything reads it.': 'Es wird wortgetreu archiviert, bevor es gelesen wird.',
  'Sorting the document': 'Dokument wird eingeordnet',
  'Working out which pages it touches.': 'Es wird ermittelt, welche Seiten betroffen sind.',
  'Writing the pages': 'Seiten werden geschrieben',
  'Quoting the document into pages, one page at a time.':
    'Das Dokument wird Seite für Seite mit Zitaten in Seiten überführt.',
  'Looking for decisions': 'Entscheidungen werden gesucht',
  'Reading it for settled choices, and checking them against the ones this wiki already holds.':
    'Es wird nach getroffenen Entscheidungen gelesen und mit den bereits erfassten abgeglichen.',
  'Checking for contradictions': 'Widersprüche werden geprüft',
  'Comparing the new claims against what is on record.':
    'Die neuen Aussagen werden mit dem vorhandenen Bestand verglichen.',
  'Preparing the change': 'Änderungsvorschlag wird erstellt',
  'Staging everything for review.': 'Alles wird zur Prüfung vorbereitet.',
  '{done} of {total} pages written': '{done} von {total} Seiten geschrieben',
  'Reading the document': 'Dokument wird gelesen',
  'Archiving it verbatim, then quoting it into pages.':
    'Es wird wortgetreu archiviert und anschließend mit Zitaten in Seiten überführt.',
  'Waiting for a worker to pick it up.': 'Wartet darauf, dass ein Worker es übernimmt.',
  'Paused on a provider quota': 'Wegen Anbieterkontingent pausiert',
  'Could not be added': 'Konnte nicht hinzugefügt werden',
  'The worker did not say why.': 'Der Worker hat keinen Grund genannt.',
  'Pages drafted': 'Seiten entworfen',
  'The synthesised pages are waiting in Decisions. Nothing here is visible knowledge until somebody approves it.':
    'Die entworfenen Seiten warten unter „Entscheidungen“. Nichts davon ist sichtbares Wissen, bevor es freigegeben wurde.',
  'Archived, with nothing to review': 'Archiviert, nichts zu prüfen',
  // Capture — parking a thought until a person sorts and resolves it.
  'Hold a thought': 'Gedanken festhalten',
  'Hold this thought': 'Diesen Gedanken festhalten',
  'About holding thoughts': 'Informationen zum Festhalten von Gedanken',
  'A parked thought is held verbatim and costs nothing: no model reads it and no queue slot is taken. It waits for a person to sort it, choose the target wiki and decide what happens next.':
    'Ein geparkter Gedanke wird wortgetreu und ohne Kosten aufbewahrt: Kein Modell liest ihn und kein Platz in der Warteschlange wird belegt. Er wartet darauf, von einem Menschen eingeordnet, einem Ziel-Wiki zugewiesen und entschieden zu werden.',
  'Park it verbatim — a title, a kind, a decision can all come later.':
    'Wortgetreu parken — Titel, Art und Entscheidung können später kommen.',
  'Whatever is in your head right now.': 'Was auch immer gerade im Kopf ist.',
  'Write the thought first.': 'Zuerst den Gedanken aufschreiben.',
  'Could not be parked': 'Konnte nicht geparkt werden',
  'Nothing is parked': 'Nichts geparkt',
  'A thought held here waits, verbatim and unread, until a person sorts and resolves it.':
    'Ein hier festgehaltener Gedanke wartet wortgetreu und ungelesen, bis ein Mensch ihn einordnet und entscheidet.',
  Thought: 'Gedanke',
  Parked: 'Geparkt',
  'Parked thought': 'Geparkter Gedanke',
  'Held verbatim. Nothing reads it until a person sorts and resolves it.':
    'Wortgetreu aufbewahrt. Nichts liest die Notiz, bis ein Mensch sie einordnet und entscheidet.',
  Discarded: 'Verworfen',
  'Never became knowledge. The row stays here for the record.':
    'Wurde nie zu Wissen. Die Zeile bleibt zur Nachvollziehbarkeit erhalten.',
  'About version history': 'Informationen zum Versionsverlauf',
  'About webhook addresses': 'Informationen zu Webhook-Adressen',
  'About webhook subscriptions': 'Informationen zu Webhook-Abonnements',
  'About wiki exchange formats': 'Informationen zu Wiki-Austauschformaten',
  'About the cross-wiki overview': 'Informationen zur wikiübergreifenden Übersicht',
  'Across every wiki': 'Über alle Wikis',
  Oldest: 'Älteste',
  'From generated reports': 'Aus generierten Berichten',
  'from generated reports': 'aus generierten Berichten',
  'Every wiki this key can see, summed: changes waiting for a decision, how long the oldest has waited, and how much arrived in the last 7 days.':
    'Alle für diesen Zugang sichtbaren Wikis, aufsummiert: Änderungen, die auf eine Entscheidung warten, das Alter der ältesten und der Umfang der letzten 7 Tage.',
  'counts the waiting changes whose every cited source came out of the wiki itself — promoted answers, briefings, check reports. That is provenance, not a verdict: it says where the evidence came from, so distilled human knowledge is not buried under machine-written backlog.':
    'zählt die wartenden Änderungen, deren sämtliche zitierten Quellen aus dem Wiki selbst stammen – übernommene Antworten, Kurzberichte und Prüfberichte. Das ist Herkunft, kein Urteil: Es zeigt, woher die Nachweise kommen, damit aufbereitetes menschliches Wissen nicht unter maschinell erzeugtem Rückstand verschwindet.',
  'About wiki keywords': 'Informationen zu Wiki-Schlüsselwörtern',
  'About wiki purpose': 'Informationen zum Wiki-Zweck',
  'About writing pages by hand': 'Informationen zum manuellen Verfassen von Seiten',
  'A stable upstream id lets each push archive a new version without forking the archive. Older versions remain available to the claims that quote them.':
    'Eine stabile Upstream-ID ermöglicht es, bei jedem Push eine neue Version zu archivieren, ohne das Archiv aufzuteilen. Ältere Versionen bleiben für die Aussagen verfügbar, die sie zitieren.',
  'Add a document to archive evidence and draft reviewable pages.':
    'Ein Dokument hinzufügen, um Nachweise zu archivieren und prüfbare Seitenentwürfe zu erstellen.',
  'Add a source or edit a page to raise the first change.':
    'Eine Quelle hinzufügen oder eine Seite bearbeiten, um die erste Änderung zu erstellen.',
  'An HTTPS address WikiKit can reach. Deliveries are POST requests, not browser pages.':
    'Eine für WikiKit erreichbare HTTPS-Adresse. Zustellungen sind POST-Anfragen und keine Browserseiten.',
  'An endpoint subscribed to everything also receives event types introduced in later releases.':
    'Ein Endpunkt mit einem Abonnement für alle Ereignisse empfängt auch Ereignistypen aus späteren Versionen.',
  'Approve a change carrying a decision to add it here.':
    'Eine Änderung mit Entscheidung freigeben, damit sie hier erscheint.',
  'Changing this rebuilds the search index for this wiki.': 'Eine Änderung erstellt den Suchindex dieses Wikis neu.',
  'Claims and the quotes behind them come from ingesting sources. A page written here stages text only.':
    'Aussagen und die zugehörigen Zitate entstehen beim Einlesen von Quellen. Eine hier verfasste Seite stellt nur Text zur Prüfung bereit.',
  'Connector-pushed documents appear here with their current version.':
    'Von Connectoren übertragene Dokumente erscheinen hier mit ihrer aktuellen Version.',
  'Create a key for an agent, connector or script.':
    'Einen Schlüssel für einen Agenten, Connector oder ein Skript erstellen.',
  'Create a page here or add evidence under Sources.':
    'Hier eine Seite erstellen oder unter „Quellen“ Nachweise hinzufügen.',
  'Derived overview': 'Abgeleitete Übersicht',
  'Grant a person access through a configured identity provider.':
    'Einer Person über einen konfigurierten Identitätsanbieter Zugriff gewähren.',
  'Every classification and synthesis job reads this text. Write the scope, vocabulary and boundaries a contributor needs.':
    'Jeder Klassifizierungs- und Syntheseauftrag liest diesen Text. Geltungsbereich, Vokabular und Grenzen für Mitwirkende beschreiben.',
  'How search reduces words before matching them.':
    'Wie die Suche Wörter vor dem Abgleich auf ihre Grundform reduziert.',
  'Ingest a source to add quoted, reviewable claims to this page.':
    'Eine Quelle einlesen, um dieser Seite zitierte, prüfbare Aussagen hinzuzufügen.',
  'Import with the API or CLI, then review the change it raises in this cockpit.':
    'Über API oder CLI importieren und anschließend die erzeugte Änderung in diesem Cockpit prüfen.',
  'Register an endpoint to receive signed WikiKit events.':
    'Einen Endpunkt registrieren, um signierte WikiKit-Ereignisse zu empfangen.',
  'Search approved knowledge or include archived source evidence.':
    'Freigegebenes Wissen durchsuchen oder archivierte Quellennachweise einbeziehen.',
  'Write the rules that guide classification and synthesis for this wiki.':
    'Regeln verfassen, die Klassifizierung und Synthese für dieses Wiki steuern.',
  'No approved change has written a revision for this page yet.':
    'Noch keine freigegebene Änderung hat eine Revision für diese Seite geschrieben.',
  'No subscribed event has happened since this endpoint was registered.':
    'Seit der Registrierung dieses Endpunkts ist kein abonniertes Ereignis eingetreten.',
  'The configured provider id. Any other value is refused.':
    'Die konfigurierte Anbieter-ID. Jeder andere Wert wird abgelehnt.',
  'The name identifies this key later; the secret itself is never shown again or stored.':
    'Der Name identifiziert diesen Schlüssel später; das Geheimnis selbst wird weder erneut angezeigt noch gespeichert.',
  'The page as fetched and projected to Markdown. The live page may have changed since.':
    'Die abgerufene und in Markdown überführte Seite. Die Live-Seite kann sich inzwischen geändert haben.',
  'The stable id the provider sends for this person, rather than their changeable email.':
    'Die stabile ID, die der Anbieter für diese Person sendet, statt ihrer veränderlichen E-Mail-Adresse.',
  'What WikiKit knows about these bytes. The hash makes the same document ingested twice one source rather than two.':
    'Was WikiKit über diese Bytes weiß. Der Hash sorgt dafür, dass dasselbe zweimal eingelesene Dokument eine Quelle bleibt.',
  'carries the structure as well as the text, so imported claims still quote their sources.':
    'enthält neben dem Text auch die Struktur, sodass importierte Aussagen weiterhin ihre Quellen zitieren.',
  'is a zip of ordinary files — one per page, decision and source, plus an index. It is best for reading and is lossy: claims, citations and relations become prose rather than structure.':
    'ist ein ZIP-Archiv mit gewöhnlichen Dateien – je eine pro Seite, Entscheidung und Quelle sowie einem Index. Es eignet sich zum Lesen, verliert aber Struktur: Aussagen, Zitate und Beziehungen werden zu Fließtext.',
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
  // The two evidence-tier filters. Their labels say "archived", never
  // "changed": the window is over when a source ARRIVED, and the German has to
  // keep that apart from the pages index's "Geändert innerhalb".
  'Archived within': 'Archiviert innerhalb',
  'Kind of source': 'Art der Quelle',
  'Archived in the last 7 days': 'In den letzten 7 Tagen archiviert',
  'Archived in the last 30 days': 'In den letzten 30 Tagen archiviert',
  'Archived in the last 90 days': 'In den letzten 90 Tagen archiviert',
  'Any kind': 'Beliebige Art',
  Meetings: 'Besprechungen',
  Articles: 'Artikel',
  // Not "Notes": that phrase is already this catalog's "Hinweise" elsewhere,
  // and one English string cannot mean two German things.
  'Written notes': 'Notizen',
  'Search the whole archive': 'Gesamtes Archiv durchsuchen',
  'Only sources whose sender declared a kind can match; sources that declared none are left out.':
    'Nur Quellen mit angegebener Art können passen; Quellen ohne Angabe bleiben außen vor.',
  'Ask instead of searching': 'Frage beantworten lassen',
  'Answer this question': 'Diese Frage beantworten',
  'A word or a phrase': 'Ein Wort oder eine Wortgruppe',
  'Alternatives turned down': 'Verworfene Alternativen',
  'Related pages': 'Verwandte Seiten',
  // Neighborhood panel — the three groups around a page.
  Outgoing: 'Ausgehend',
  Incoming: 'Eingehend',
  'Same sources': 'Gleiche Quellen',
  'No neighbors yet': 'Noch keine Nachbarn',
  'No quote': 'Kein Zitat',
  'No claims on this page yet.': 'Auf dieser Seite steht noch keine Aussage.',
  'No reviewed relation touches this page, and no other page quotes the sources it quotes.':
    'Keine geprüfte Verknüpfung berührt diese Seite, und keine andere Seite zitiert dieselben Quellen.',
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
    'Reines Markdown. Jeder Klassifizierungs- und Syntheseauftrag liest diese Regeln. Geltungsbereich, Begriffe und Ausschlüsse beschreiben.',
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
    'Jede Aussage auf diesen Seiten benötigt ein Zitat aus einer archivierten Quelle. Inhalt vor der Entscheidung prüfen.',
  'A decision this wiki recorded: what was decided, why, and what was turned down.':
    'Eine dokumentierte Entscheidung dieses Wikis mit Begründung und verworfenen Alternativen.',
  'Clear filter': 'Filter löschen',
  'Show every page': 'Alle Seiten anzeigen',
  'Deleted pages': 'Gelöschte Seiten',
  Restore: 'Wiederherstellen',
  'Changed within': 'Geändert innerhalb',
  'No pages changed in that window': 'In diesem Zeitraum wurden keine Seiten geändert',
  'No pages yet': 'Noch keine Seiten',
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
    'Eine Seite beschreibt das Wissen dieses Wikis; jede Aussage enthält ein wörtliches Zitat aus einer Quelle. Eine Seite schreiben oder unter „Quellen“ ein Dokument hinzufügen und die daraus erstellten Seiten prüfen.',
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
  'What are you adding?': 'Was wird hinzugefügt?',
  'What is it? (optional)': 'Welche Art ist es? (optional)',
  'What is this key for?': 'Wofür wird dieser Schlüssel verwendet?',
  'What may it do?': 'Was darf er tun?',
  'What should it hear about?': 'Über welche Ereignisse soll es informiert werden?',
  'What this wiki told the outside world, and what never arrived.':
    'Was dieses Wiki an andere Systeme gesendet hat und was nicht angekommen ist.',
  'Where the knowledge is thin': 'Wo Nachweise fehlen',
  'WikiKit has no way to delete a wiki.': 'WikiKit bietet keine Möglichkeit, ein Wiki zu löschen.',
  'Your decision': 'Entscheidung',
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
    'Der Filter zeigt nur einen Ausschnitt. „Alle“ zeigt jeden Schlüssel.',
  'Revoke this key?': 'Diesen Schlüssel widerrufen?',
  'Revoke key': 'Schlüssel widerrufen',
  'This key will never be shown again': 'Dieser Schlüssel wird nie wieder angezeigt',
  'No changes with that status': 'Keine Änderungen mit diesem Status',
  'No change has ever been raised in this wiki. Adding a document under Sources, or editing a page, is what puts one here.':
    'In diesem Wiki wurde noch keine Änderung eingereicht. Das Hinzufügen eines Dokuments unter Quellen oder das Bearbeiten einer Seite erzeugt eine Änderung.',
  'No source named': 'Keine Quelle angegeben',
  'This address is missing the id of a source. Open one from the Sources list.':
    'In dieser Adresse fehlt die Quelle. Eine Quelle aus der Quellenliste öffnen.',
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
    'Der Filter zeigt nur einen Ausschnitt. „Alle“ zeigt jede Freigabe.',
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
    'Entfernt ausschließlich Beziehungen zwischen vorhandenen Seiten. Die betroffenen Beziehungen stehen unten.',
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
    'Ein Wiki ohne Nachweise kann kein Wissen enthalten. Ein Dokument hinzufügen; WikiKit archiviert es wörtlich und entwirft daraus zitierte Seiten.',
  'No connector streams': 'Keine Konnektor-Datenströme',
  'Forget this stream?': 'Diesen Datenstrom vergessen?',
  'Forget stream': 'Datenstrom vergessen',
  'No endpoints registered': 'Keine Endpunkte registriert',
  'Nothing outside WikiKit is being told about this wiki. Register a URL and WikiKit posts a signed event to it whenever a change is raised, approved or rejected.':
    'Kein externes System wird über dieses Wiki informiert. Eine URL registrieren; WikiKit sendet signierte Ereignisse, wenn Änderungen eingereicht, freigegeben oder abgelehnt werden.',
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
    'Ein Wiki enthält Seiten, ihre Quellen und noch zu prüfende Änderungen. Zum Einstieg ein Wiki über die API erstellen.',
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
    'Bestrittene Aussagen, lange nicht überarbeitete Seiten und die Wartezeit offener Änderungen.',
  'Closing this panel discards it. WikiKit kept the hash, not the key.':
    'Durch das Schließen dieses Panels wird es verworfen. WikiKit hat den Hash behalten, nicht den Schlüssel.',
  'Comma separated. These weigh heaviest when WikiKit picks a wiki for a task, so a handful of exact terms beats a paragraph.':
    'Komma getrennt. Diese wiegen am schwersten, wenn WikiKit ein Wiki für eine Aufgabe auswählt, sodass eine Handvoll genauer Begriffe einen Absatz übertrifft.',
  'Contradicts a claim already visible on the same frame — approval marks BOTH of them disputed.':
    'Widerspricht einer bereits auf derselben Seite sichtbaren Aussage – bei Freigabe werden beide als umstritten markiert.',
  'Could not list wikis': 'Wikis konnten nicht aufgelistet werden',
  'Decisions recorded by this change (': 'Durch diese Änderung erfasste Entscheidungen (',
  'Derived from current knowledge and appended to the charter automatically, together with an index of every page in this wiki. It is not part of the text above and cannot be edited here.':
    'Aus dem aktuellen Wissen abgeleitet und zusammen mit einem Seitenindex automatisch an die Leitlinien angehängt. Dieser Abschnitt gehört nicht zum bearbeitbaren Text.',
  'Displays the mobile sidebar.': 'Zeigt die mobile Seitenleiste an.',
  'Emptying either box removes what is stored. The email does not stay empty: every sign-in writes back whatever the provider asserts. To keep it gone, clear it and then revoke the grant — a revoked identity cannot sign in, so nothing rewrites it — or remove the person at the provider.':
    'Ein leeres Feld entfernt den gespeicherten Wert. Bei jeder Anmeldung übernimmt WikiKit die E-Mail erneut vom Anbieter. Damit sie dauerhaft leer bleibt, den Wert löschen und anschließend den Zugriff widerrufen oder die Person beim Anbieter entfernen.',
  'Every MCP client this installation serves, across all wikis rather than just':
    'Jeder MCP-Client, den diese Installation bedient, in allen Wikis und nicht nur',
  'Every charter written for this wiki, newest first. Writing supersedes the current revision rather than overwriting it.':
    'Alle Fassungen der Leitlinien, neueste zuerst. Eine neue Fassung ersetzt die aktuelle, ohne den Verlauf zu überschreiben.',
  'Every claim carries a citation, no claim collides with a visible one, and no relation points at a page that is not there.':
    'Jede Aussage besitzt einen Quellenbeleg, widerspricht keiner sichtbaren Aussage und verweist nur auf vorhandene Seiten.',
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
    'Legt fest, wie Wörter vor dem Abgleich auf ihren Stamm reduziert werden. Eine Änderung baut den Suchindex aller Seiten und Quellen neu auf.',
  'How this wiki describes itself to agents, which language its search is stemmed in, and which other wikis it may read.':
    'Wie sich dieses Wiki den Agenten selbst beschreibt, in welcher Sprache die Suche erfolgt und welche anderen Wikis es möglicherweise liest.',
  'How to read this document': 'Dokument lesen',
  'I have stored it — close': 'Ich habe ihn gespeichert – schließen',
  'Importing a bundle is not done from this console. Sources in an imported bundle are archived directly — evidence asserts nothing — but its pages and claims are staged as a single change for review, exactly like knowledge WikiKit synthesized itself. Use the API or the CLI, then review the change it raises.':
    'Bundles werden über API oder CLI importiert. Quellen werden direkt archiviert; Seiten, Aussagen und Belege landen gemeinsam in einer Änderung zur Prüfung.',
  In: 'In',
  'Including event types added in later releases — an endpoint that subscribes to everything keeps subscribing to everything.':
    'Einschließlich der in späteren Versionen hinzugefügten Ereignistypen – ein Endpunkt, der alles abonniert, abonniert weiterhin alles.',
  'Knowledge health in': 'Wissensqualität in',
  'Lower-case letters, digits and hyphens. Every link to this page will use it, so it does not change later.':
    'Kleinbuchstaben, Ziffern und Bindestriche. Jeder Link zu dieser Seite verwendet es, sodass es sich später nicht ändert.',
  'Lower-case letters, digits and hyphens. It is the address of this wiki in every URL and every API call, and it cannot be changed afterwards.':
    'Kleinbuchstaben, Ziffern und Bindestriche. Es ist die Adresse dieses Wikis in jeder URL und jedem API-Aufruf und kann nachträglich nicht mehr geändert werden.',
  'Move this one page into a change of its own, so the rest can be decided now.':
    'Diese Seite in eine eigene Änderung verschieben, damit der Rest jetzt entschieden werden kann.',
  'Name the claim that is unsupported, or the source that has to be quoted.':
    'Die unbelegte Aussage oder die noch zu zitierende Quelle benennen.',
  'No archived source is attached. Every claim above is therefore unciteable — that is what the missing-citations check reports.':
    'Keine archivierte Quelle ist angehängt. Die Aussagen oben lassen sich daher nicht belegen; genau das meldet die Prüfung auf fehlende Zitate.',
  'No charter has ever been written for this wiki.': 'Für dieses Wiki wurden noch keine Leitlinien verfasst.',
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
    'Für diese Aussage ist kein Zitat aus dem Archiv hinterlegt; sie lässt sich daher nicht prüfen.',
  'Nothing is deleted. The versions already archived stay exactly as they are, and every page that quotes them keeps its evidence — a claim never loses its citation.':
    'Nichts wird gelöscht. Archivierte Versionen bleiben unverändert und jede Seite behält ihre Quellenbelege.',
  'Nothing is published. This change is closed for good and marked as having changes requested; WikiKit has no rebase, so acting on your note produces a NEW change rather than an edit to this one.':
    'Nichts wird veröffentlicht. Die Änderung wird mit Änderungswunsch geschlossen. Eine Überarbeitung erzeugt anschließend eine neue Änderung.',
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
  'Read the': 'Öffnen:',
  'Read the archived source': 'Archivierte Quelle öffnen',
  Reading: 'Lektüre',
  'Reading from': 'Lesen aus',
  'Ready to copy': 'Bereit zum Kopieren',
  'Relations this change takes away (': 'Beziehungen, die diese Änderung wegnimmt (',
  'Relations this page adds (': 'Beziehungen, die diese Seite hinzufügt (',
  'Replaced by': 'Ersetzt durch',
  'Requests to': 'Anfragen an',
  'Results come in two tiers: what this wiki has approved, and — if you ask for them — lines found only in the archived sources behind it. The second tier is evidence, not knowledge.':
    'Ergebnisse bestehen aus freigegebenem Wissen und optional aus Treffern in archivierten Quellen. Die zweite Ebene ist Evidenz, noch kein freigegebenes Wissen.',
  'Review the change →': 'Änderung prüfen →',
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
    'Leitlinien sind Administrationskonfiguration und durchlaufen keine Änderungsprüfung.',
  'The diff above is unaffected — this check is advisory. Nothing here says the change is clean; it says nobody looked.':
    'Der obige Unterschied ist davon nicht betroffen – diese Prüfung ist beratend. Nichts hier besagt, dass die Änderung sauber ist; Es heißt, niemand hat nachgeschaut.',
  'The id of a provider this deployment is configured to authenticate against. Anything else is refused — a typo would otherwise create a grant no login can ever match.':
    'Die ID eines Anbieters, bei dem diese Bereitstellung für die Authentifizierung konfiguriert ist. Alles andere wird abgelehnt – ein Tippfehler würde andernfalls zu einer Bewilligung führen, mit der kein Login jemals übereinstimmen kann.',
  'The interchange bundle: claims, citations and relations survive the round trip.':
    'Das Austauschbundle erhält Aussagen, Quellenbelege und Beziehungen vollständig.',
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
    'Der vorgeschlagene Text bleibt im Prüfverlauf, wird aber nicht veröffentlicht. „Änderungen anfordern“ verwenden, wenn eine Überarbeitung erwartet wird; eine Ablehnung enthält keine Arbeitsanweisung.',
  'The version before this one': 'Die Version vor dieser',
  'The version this process is serving, and a fingerprint of every document it publishes about itself — so a deployment can be compared without downloading any of them.':
    'Die Version, die dieser Prozess bereitstellt, und ein Fingerabdruck jedes Dokuments, das er über sich selbst veröffentlicht – sodass eine Bereitstellung verglichen werden kann, ohne dass eines davon heruntergeladen werden muss.',
  'Their work stays. Pages they wrote stay visible, changes they raised stay in the queue, and decisions they approved stay approved — revoking access has never rewritten history here.':
    'Die bisherige Arbeit bleibt erhalten: Seiten, Änderungen und Entscheidungen werden durch den Zugriffswiderruf nicht umgeschrieben.',
  'There is no preset that can approve a change. Approving publishes knowledge, so':
    'Es gibt keine Voreinstellung, die eine Änderung genehmigen kann. Die Genehmigung veröffentlicht Wissen, also',
  'There is no way back. WikiKit stores a hash and never the key, so a revoked key cannot be re-enabled — mint a replacement, hand it to whatever was using this one, and revoke afterwards to avoid a gap.':
    'Der Widerruf lässt sich nicht rückgängig machen. WikiKit speichert nur einen Hash. Zuerst einen Ersatzschlüssel verteilen und anschließend den alten Schlüssel widerrufen, um Unterbrechungen zu vermeiden.',
  "This decision is yours, not an agent's. Approving publishes the pages above into":
    'Diese Entscheidung trifft ein Mensch, kein Agent. Die Freigabe veröffentlicht die oben genannten Seiten in',
  'This document has a stable id upstream, so each push archives a new version instead of forking the archive. Older versions stay exactly where they are — the claims that quote them keep their evidence.':
    'Dieses Dokument besitzt upstream eine stabile ID. Jeder Push archiviert eine neue Version; ältere Versionen und ihre Quellenbelege bleiben erhalten.',
  'This document is too large to diff line by line without freezing the tab. Here is what it says now, then what it would say.':
    'Dieses Dokument ist zu groß, um es Zeile für Zeile zu unterscheiden, ohne die Registerkarte einzufrieren. Hier ist, was es jetzt sagt und was es damals sagen würde.',
  'This draft exists only in this browser. Leaving now throws it away — nothing has been sent to WikiKit yet, so there is no change to come back to.':
    'Dieser Entwurf existiert nur in diesem Browser. Beim Verlassen wird er verworfen; an WikiKit wurde noch nichts gesendet.',
  'This endpoint is registered and no event it subscribes to has happened since. That is good news, not a fault — raise or approve a change and the first delivery appears here.':
    'Der Endpunkt ist registriert, aber seitdem trat kein abonniertes Ereignis auf. Nach dem nächsten passenden Ereignis erscheint hier die erste Zustellung.',
  'This form did not load their row, so a name or email left blank here keeps what is stored rather than clearing it. To remove either one, close this and use Change ceiling on their row.':
    'Dieses Formular hat den vorhandenen Eintrag nicht geladen. Leere Felder behalten daher Name und E-Mail-Adresse. Zum Entfernen den Dialog schließen und am Eintrag „Berechtigungsgrenze ändern“ öffnen.',
  'This grant is the only authorization WikiKit reads, so revoking it takes effect immediately and everywhere: the sessions this person has open right now stop working mid-request, and any API key minted through this identity is killed with it. A key bound to a grant cannot outlive the grant.':
    'Diese Zugriffsfreigabe ist die einzige von WikiKit ausgewertete Berechtigung. Ein Widerruf wirkt sofort, beendet offene Sitzungen und widerruft alle über diese Identität ausgestellten API-Schlüssel.',
  'This installation answered with two versions —': 'Diese Installation antwortete mit zwei Versionen –',
  'This installation holds no wikis yet.': 'Diese Installation enthält noch keine Wikis.',
  'This record does not name what replaced it. The': 'Dieser Datensatz nennt nicht, was ihn ersetzt hat. Der',
  'This record names none.': 'Dieser Datensatz nennt keine.',
  "This wiki's language": 'Die Sprache dieses Wikis',
  'Unanswered-question tracking is switched off in this deployment.':
    'Die Nachverfolgung unbeantworteter Fragen ist in dieser Bereitstellung deaktiviert.',
  Unstemmed: 'Ohne Wortstammerkennung',
  'Until a new charter is written, nothing steers classification and synthesis for this wiki: they fall back to their defaults. Pages already written are unaffected.':
    'Bis neue Leitlinien vorliegen, verwenden Klassifizierung und Synthese ihre Standardwerte. Bestehende Seiten bleiben unverändert.',
  'What WikiKit knows about these bytes. The hash is what makes the same document ingested twice one source rather than two.':
    'Was WikiKit über diese Bytes weiß. Der Hash ist dafür verantwortlich, dass das gleiche Dokument, das zweimal aufgenommen wurde, eine Quelle statt zwei ist.',
  'What a person calls it. This one can be changed later.':
    'Wie eine Person es nennt. Dieser kann später geändert werden.',
  "What changes: this stream leaves the list below, and the wiki's lint report starts naming the visible claims whose upstream document no longer exists, so a human can decide what to do about them. A later push from the connector brings the stream back.":
    'Der Datenstrom verschwindet aus der Liste. Der Prüfbericht markiert anschließend sichtbare Aussagen ohne vorhandenes Upstream-Dokument. Ein späterer Connector-Push stellt den Datenstrom wieder her.',
  'What reviewers did here — through this console, the API and agents alike.':
    'Was die Rezensenten hier getan haben – über diese Konsole, die API und Agenten gleichermaßen.',
  'What synthesis cost this wiki: calls, tokens and time, from the audit ledger.':
    'Kosten der Synthese für dieses Wiki: Aufrufe, Tokens und Laufzeit aus dem Prüfprotokoll.',
  'What the linter finds in this wiki: claims with no quote behind them, pages nothing links to, changes nobody has reviewed.':
    'Ergebnisse der Wiki-Prüfung: Aussagen ohne Quellenbeleg, nicht verlinkte Seiten und ungeprüfte Änderungen.',
  'Where it came from': 'Woher es kam',
  "Which markers count is configuration, so it differs between installations — this is what yours honours. Reading it is an admin's right, not a reader's; a session without it is told so here rather than shown a card that is missing.":
    'Welche Markierungen zählen, legt die Installation fest. Diese Auswertung ist nur mit Administrationsrechten sichtbar; ohne Berechtigung erscheint ein entsprechender Hinweis.',
  "WikiKit created the endpoint but sent no signing secret back, so there is nothing to give the receiving system. Delete this endpoint and register it again; if it happens twice, this deployment's webhook surface needs looking at before anything is wired to it.":
    'WikiKit hat den Endpunkt ohne Signaturgeheimnis erstellt. Den Endpunkt löschen und erneut registrieren. Tritt der Fehler wieder auf, muss die Webhook-Konfiguration dieser Installation geprüft werden.',
  'WikiKit does not answer which pages cite this source. To find them, search the wiki for a phrase from the document — every claim carries its quote.':
    'WikiKit liefert keine direkte Liste zitierender Seiten. Eine Suche nach einem Satz aus dem Dokument findet die zugehörigen Aussagen und Quellenbelege.',
  "WikiKit reads this ceiling on every request, so whatever you set here is in force on this person's next call — there is no session to wait out and nothing to re-issue.":
    'WikiKit prüft diese Berechtigungsgrenze bei jeder Anfrage. Änderungen gelten daher sofort beim nächsten Aufruf.',
  'Write the page in Markdown. Submitting stages a change — a reviewer decides whether it becomes part of the wiki.':
    'Seite in Markdown verfassen und als Änderung einreichen. Erst eine Prüfung entscheidet über die Veröffentlichung.',
  and: 'Und',
  'and answers in prose, citing what it used. It costs model tokens, so it runs only when you ask.':
    'und beantwortet die Frage mit Quellenangaben. Der Vorgang verbraucht Modell-Tokens und startet nur auf ausdrückliche Anforderung.',
  'are chosen scope by scope, on purpose.': 'werden absichtlich Bereich für Bereich ausgewählt.',
  'becomes current the moment you confirm, and revision': 'wird mit der Bestätigung aktuell; Revision',
  'can never be granted to a person — it means “everything, including whatever is added later”, which is a grant nobody can audit. That stays a key somebody minted on the host.':
    'kann keiner Person zugewiesen werden: Es umfasst auch künftig hinzugefügte Rechte und ist daher nicht sinnvoll prüfbar. Diese Berechtigung bleibt hostseitig ausgestellten Schlüsseln vorbehalten.',
  collides: 'kollidiert',
  'decision log': 'Entscheidungsprotokoll',
  'error(s),': 'Fehler,',
  'evidence to follow up — not something this wiki knows.':
    'Beweise, die weiterverfolgt werden müssen – etwas, das dieses Wiki nicht weiß.',
  'from a document this wiki archived. Nobody has reviewed':
    'aus einem Dokument, das dieses Wiki archiviert hat. Niemand hat eine Bewertung abgegeben',
  'from the list instead — it re-admits them at the ceiling that grant already carries.':
    'Stattdessen den Eintrag aus der Liste wiederherstellen. Dabei gilt erneut die bereits gespeicherte Berechtigungsgrenze.',
  'has to be chosen scope by scope, on purpose.': 'muss Bereich für Bereich absichtlich ausgewählt werden.',
  'into a page, so': 'in eine Seite, also',
  'is a zip of ordinary files — one per page, decision and source, plus an index. It is what to hand somebody who just wants to read the knowledge, and it is lossy: claims, citations and relations are prose in it, not structure.':
    'ist eine ZIP-Datei mit je einer Datei pro Seite, Entscheidung und Quelle sowie einem Index. Das Format ist gut lesbar, verliert aber die Struktur von Aussagen, Quellenbelegen und Beziehungen.',
  'is already admitted on this provider and subject, so this is not a new grant. Submitting replaces their current ceiling —':
    'ist für diesen Anbieter und dieses Subjekt bereits zugelassen. Die Eingabe ersetzt daher die bestehende Berechtigungsgrenze –',
  'is left with no charter. Every revision stays readable in the history below — this deletes what is in force, not the record of it.':
    'bleibt ohne Leitlinien. Jede Fassung bleibt im Verlauf lesbar; entfernt wird nur die aktuell gültige Fassung.',
  'is superseded and': 'wird ersetzt und',
  'is superseded — kept in history, no longer in force. Classification and synthesis in':
    'wird ersetzt – in der Geschichte beibehalten, nicht mehr in Kraft. Klassifizierung und Synthese in',
  'is the interchange bundle. It carries the structure as well as the text, so a wiki exported from one WikiKit and imported into another arrives with its claims still quoting their sources.':
    'ist das Austauschbundle. Es erhält neben dem Text auch Aussagen, Quellenbelege und Beziehungen vollständig.',
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
  'About adding documents': 'Informationen zum Hinzufügen von Dokumenten',
  'Every item becomes its own archived source and its own change, so one unreadable file never takes the rest of a drop with it. Nothing here is visible knowledge until somebody approves the change it raises.':
    'Jedes Element wird zu einer eigenen archivierten Quelle und einer eigenen Änderung; eine unlesbare Datei reißt die übrigen nicht mit. Nichts davon ist sichtbares Wissen, bevor die erzeugte Änderung freigegeben wurde.',
  'Throw something in': 'Etwas einwerfen',
  'Drop documents here': 'Dokumente hier ablegen',
  'pdf, docx, xlsx, md, txt, csv — one job per file.': 'pdf, docx, xlsx, md, txt, csv — ein Auftrag pro Datei.',
  'Choose files': 'Dateien auswählen',
  'Some files were not sent': 'Einige Dateien wurden nicht gesendet',
  'Paste addresses, one per line': 'Adressen einfügen, eine pro Zeile',
  'Lines that are not http:// or https:// addresses are ignored:':
    'Zeilen ohne http:// oder https:// Adresse werden ignoriert:',
  'Fetch these pages': 'Diese Seiten abrufen',
  'Throw in a note or a document': 'Eine Notiz oder ein Dokument einwerfen',
  'A meeting note, an email, a transcript, a Markdown page.':
    'Eine Besprechungsnotiz, eine E-Mail, ein Transkript, eine Markdown-Seite.',
  'Add this document': 'Dieses Dokument hinzufügen',
  'Still needs your decision': 'Wartet noch auf eine Entscheidung',
  'What arrived became pages. None of them is visible knowledge until a person approves it.':
    'Aus dem Eingegangenen wurden Seiten. Keine davon ist sichtbares Wissen, bevor eine Person sie freigibt.',
  'Every change this wiki has raised has been decided.': 'Über jede Änderung dieses Wikis wurde entschieden.',
  'The whole review queue': 'Die gesamte Prüfwarteschlange',
  'What arrived': 'Was eingegangen ist',
  'Nothing has arrived yet': 'Es ist noch nichts eingegangen',
  'Drop a document, paste an address, or throw in a note — the pages come back as proposals to review.':
    'Ein Dokument ablegen, eine Adresse einfügen oder eine Notiz einwerfen — die Seiten kommen als Vorschläge zur Prüfung zurück.',
  'The archive': 'Das Archiv',
  'The archived document': 'Das archivierte Dokument',
  'Review the change': 'Änderung prüfen',
  'The rest of this drop was not sent. Deciding the changes already waiting is what makes room.':
    'Der Rest dieses Stapels wurde nicht gesendet. Erst entschiedene Änderungen schaffen wieder Platz.',
  'Clear this report': 'Diesen Bericht ausblenden',
  Clear: 'Leeren',
  'Everything that arrived': 'Alles Eingegangene',
  'Waiting for a worker': 'Wartet auf einen Worker',
  'Being read': 'Wird gelesen',
  'Paused on a quota': 'Wegen Kontingent pausiert',
  Arrived: 'Eingegangen',
  Result: 'Ergebnis',
  'Not sent': 'Nicht gesendet',
  Sending: 'Wird gesendet',
  Added: 'Hinzugefügt',
  Refused: 'Abgelehnt',
  '{queued} added · {refused} refused · {pending} not sent':
    '{queued} hinzugefügt · {refused} abgelehnt · {pending} nicht gesendet',
  'Needs knowledge:propose': 'Erfordert knowledge:propose',
  'Paste at least one address.': 'Mindestens eine Adresse einfügen.',
  'Paste the document first.': 'Zuerst das Dokument einfügen.',
  'This file is empty.': 'Diese Datei ist leer.',
  items: 'Einträge',
  'Ask a question': 'Eine Frage stellen',
  'Everything produced': 'Alles Erzeugte',
  Briefings: 'Kurzberichte',
  'Check reports': 'Prüfberichte',
  Answer: 'Antwort',
  Briefing: 'Kurzbericht',
  'Check report': 'Prüfbericht',
  'In the wiki': 'Im Wiki',
  'Not filed': 'Nicht übernommen',
  'What was produced': 'Erzeugtes',
  Produced: 'Erzeugt',
  'Untitled output': 'Ergebnis ohne Titel',
  Output: 'Ergebnis',
  'Nothing produced yet': 'Noch nichts erzeugt',
  'Ask this wiki a question and the answer is kept here, with the pages it quoted.':
    'Eine Frage an dieses Wiki wird hier mitsamt den zitierten Seiten aufbewahrt.',
  'Nothing of that kind': 'Nichts dieser Art',
  'This is what the filter is showing, not what the wiki holds.':
    'Der Filter zeigt nur einen Ausschnitt, nicht den gesamten Bestand.',
  'This answer is kept — open it to file it back': 'Diese Antwort ist gespeichert – zum Übernehmen öffnen',
  'What this wiki produced, the pages it quoted, and the way back into the wiki.':
    'Was dieses Wiki erzeugt hat, welche Seiten es zitiert hat und der Weg zurück ins Wiki.',
  'No answer named': 'Keine Antwort angegeben',
  'This address is missing the id of an answer. Open one from the Answers list.':
    'In dieser Adresse fehlt die Antwort. Eine Antwort aus der Liste öffnen.',
  'What this is': 'Worum es sich handelt',
  'The question': 'Die Frage',
  'This document has no text in it.': 'Dieses Dokument enthält keinen Text.',
  'Cited pages': 'Zitierte Seiten',
  'This document quotes no page of this wiki.': 'Dieses Dokument zitiert keine Seite dieses Wikis.',
  'Take this into the wiki': 'In das Wiki übernehmen',
  'The text above is archived as a source and read into pages, exactly like a document dropped in the Inbox. Nothing here becomes visible knowledge until somebody approves the change it raises.':
    'Der Text oben wird als Quelle archiviert und wie ein im Eingang abgelegtes Dokument in Seiten überführt. Nichts davon wird sichtbares Wissen, bevor die erzeugte Änderung freigegeben wurde.',
  'File this back into the wiki?': 'Diesen Text zurück ins Wiki übernehmen?',
  'The text above is archived as a source and read into pages.':
    'Der Text oben wird als Quelle archiviert und in Seiten überführt.',
  'This creates a change somebody has to decide.': 'Dadurch entsteht eine Änderung, über die jemand entscheiden muss.',
  'The document is archived verbatim, quoted claim by claim into pages, and staged as one change proposal — the same path a document dropped in the Inbox takes.':
    'Das Dokument wird wortgetreu archiviert, Aussage für Aussage mit Zitaten in Seiten überführt und als eine Änderung zur Prüfung vorgemerkt — derselbe Weg wie bei einem im Eingang abgelegten Dokument.',
  "The source it archives is marked as coming from this wiki's own answer, so knowledge that ends up resting only on answers is reported under Check rather than passing as evidence from outside.":
    'Die archivierte Quelle wird als eigene Antwort dieses Wikis gekennzeichnet. Wissen, das nur noch auf Antworten beruht, erscheint dadurch unter „Prüfen“ und gilt nicht als Nachweis von außen.',
  'Filing the same text twice archives nothing twice: the second attempt is refused with the source that already holds it.':
    'Derselbe Text wird nicht zweimal archiviert: Der zweite Versuch wird mit Verweis auf die vorhandene Quelle abgelehnt.',
  'File it back': 'Zurück ins Wiki übernehmen',
  'Needs knowledge:propose — filing this back raises a change for review.':
    'Erfordert knowledge:propose – die Übernahme erzeugt eine Änderung zur Prüfung.',
  'Filed back — a change is waiting for review': 'Zurück ins Wiki übernommen – eine Änderung wartet auf Prüfung',
  'Filed back into the wiki': 'Zurück ins Wiki übernommen',
  'The review queue': 'Die Prüfwarteschlange',
  'What is waiting': 'Was wartet',
  'Proposals waiting for a person': 'Vorschläge, die auf einen Menschen warten',
  'Nothing in this wiki becomes visible knowledge until somebody decides it.':
    'Nichts in diesem Wiki wird sichtbares Wissen, bevor jemand darüber entscheidet.',
  'The oldest has waited': 'Die älteste wartet seit',
  'Waiting for a decision': 'Wartet auf eine Entscheidung',
  'Documents still being read': 'Dokumente, die noch gelesen werden',
  'Work the pipeline has not finished. A parked job is counted beside the queue, not inside it.':
    'Arbeit, welche die Verarbeitung noch nicht abgeschlossen hat. Ein pausierter Auftrag zählt neben der Warteschlange, nicht darin.',
  'In the queue': 'In der Warteschlange',
  'Longest wait': 'Längste Wartezeit',
  'About these findings': 'Informationen zu diesen Befunden',
  'Found by reading this wiki, without a model: claims with no quote behind them, pages that contradict each other, pages nothing links to, changes nobody has reviewed.':
    'Ohne Modell aus diesem Wiki gelesen: Aussagen ohne Beleg, einander widersprechende Seiten, nicht verlinkte Seiten und ungeprüfte Änderungen.',
  'What the linter found': 'Prüfbefunde',
  'What needs checking': 'Was geprüft werden muss',
  'Claims with no quote behind them, pages that contradict each other, knowledge nobody has revisited.':
    'Aussagen ohne Beleg, einander widersprechende Seiten und Wissen, das niemand mehr überarbeitet hat.',
  'What this wiki needs': 'Was dieses Wiki braucht',
  'What readers asked for': 'Wonach gefragt wurde',
  'An answer is kept, with the pages it quoted, and a good one can be filed back in.':
    'Eine Antwort wird mit den zitierten Seiten aufbewahrt; eine gute davon kann zurück ins Wiki übernommen werden.',
  'Ask this wiki something': 'Diesem Wiki eine Frage stellen',
  today: 'heute',
  '1 day': '1 Tag',
  '{count} days': '{count} Tage',
  'under an hour': 'unter einer Stunde',
  '{count} h': '{count} Std.',
  // Check — the parked-thoughts facts, the
  // per-rule "why it counts" help, the fold of stale vs. census proposal rows
  // and the kept-reports history.
  'Parked thoughts': 'Geparkte Gedanken',
  'oldest: {age}': 'älteste: {age}',
  'A change waiting past two weeks appears once, as a warning ({count} folded).':
    'Eine Änderung, die länger als zwei Wochen wartet, erscheint einmal — als Warnung ({count} zusammengefasst).',
  'Why it counts': 'Warum es zählt',
  'About kept reports': 'Informationen zu aufbewahrten Berichten',
  'Every scheduled check keeps its report here, under Answers — including a run that found nothing, because an empty report is information: it says somebody looked.':
    'Jede geplante Prüfung bewahrt ihren Bericht hier unter „Antworten“ auf – auch ohne Befund. Ein leerer Bericht zeigt, dass geprüft wurde.',
  'Kept check reports': 'Aufbewahrte Prüfberichte',
  'No report kept yet': 'Noch kein Bericht aufbewahrt',
  'The first scheduled check files its report here — switch one on in the timetable below.':
    'Die erste geplante Prüfung legt ihren Bericht hier ab und lässt sich im Zeitplan darunter einschalten.',
  'Two visible claims assert different things about the same frame. Readers cannot tell which one the wiki means until a person deprecates one side.':
    'Zwei sichtbare Aussagen behaupten Unterschiedliches über denselben Rahmen. Bis ein Mensch eine Seite zurückzieht, bleibt offen, was das Wiki meint.',
  'A visible claim quotes no source, so nobody can check it. Verifiable quotes are the whole promise of this wiki.':
    'Eine sichtbare Aussage zitiert keine Quelle und ist damit nicht nachprüfbar. Belegte Zitate sind das Versprechen dieses Wikis.',
  'A link points at a page that cannot be read. Whoever follows it lands nowhere.':
    'Ein Verweis zeigt auf eine Seite, die nicht lesbar ist. Wer ihm folgt, landet im Leeren.',
  'The claim describes a window that has closed. It needs re-verification or retirement.':
    'Die Aussage beschreibt ein abgelaufenes Zeitfenster und braucht eine neue Bestätigung oder den Ruhestand.',
  'No link leads to or from this page, so graph navigation never finds it. Sometimes that is fine; usually a relation is missing.':
    'Kein Verweis führt zu dieser Seite oder von ihr weg; die Graph-Navigation findet sie nie. Manchmal ist das in Ordnung, meist fehlt eine Beziehung.',
  'No archived document stands behind this page. Adding a source lets synthesis quote real evidence.':
    'Hinter dieser Seite steht kein archiviertes Dokument. Mit einer neuen Quelle kann die Synthese echte Belege zitieren.',
  'Every source this page quotes came out of the wiki itself. Without outside evidence the wiki is confirming itself.':
    'Jede Quelle dieser Seite stammt aus dem Wiki selbst. Ohne Belege von außen bestätigt sich das Wiki nur selbst.',
  'The page is blank in every sense: no text, no claims, no links. Delete it or give it content.':
    'Die Seite ist in jeder Hinsicht leer: kein Text, keine Aussagen, keine Verweise. Löschen oder füllen.',
  'The page is marked as a reference target yet holds real claims. Until one of the two is fixed, its evidence is withheld from the index.':
    'Die Seite ist als Referenzziel markiert und trägt trotzdem echte Aussagen. Bis eines von beiden korrigiert ist, fehlt ihr Nachweis im Index.',
  'The page states nothing checkable. Fine for a stub — worth knowing about.':
    'Die Seite enthält nichts Nachprüfbares. Für einen Platzhalter in Ordnung — aber gut zu wissen.',
  'A change is waiting for a decision. Nothing becomes visible knowledge until a person makes it.':
    'Eine Änderung wartet auf eine Entscheidung. Nichts wird sichtbares Wissen, bevor ein Mensch sie trifft.',
  'An archived document no claim quotes. Often just a change still waiting for review.':
    'Ein archiviertes Dokument, das keine Aussage zitiert. Oft nur eine Änderung, die noch auf ihre Freigabe wartet.',
  'The claim quotes a document deleted upstream. The archived copy remains valid evidence; whether the claim stays is a human call.':
    'Die Aussage zitiert ein Dokument, das am Ursprungsort gelöscht wurde. Die archivierte Kopie bleibt gültiger Beleg; ob die Aussage bleibt, entscheidet ein Mensch.',
  'A link into another wiki reaches no readable page there. The link convention is documentation; fixing it keeps documents honest.':
    'Ein Verweis in ein anderes Wiki erreicht dort keine lesbare Seite. Die Verweis-Konvention ist Dokumentation; die Korrektur hält Dokumente ehrlich.',
  'Nothing steers what belongs in this wiki. Guidelines are optional — this note makes their absence a choice, not an accident.':
    'Nichts steuert, was in dieses Wiki gehört. Leitlinien sind freiwillig — diese Notiz macht ihr Fehlen zu einer Entscheidung statt zu einem Zufall.',
  'This change has waited more than two weeks. Age is what turns a queue into a backlog.':
    'Diese Änderung wartet seit mehr als zwei Wochen. Erst das Alter macht aus einer Warteschlange einen Rückstand.',
  'This thought has been parked for over a month. An old inbox item is a signal, not an error — sort and resolve it.':
    'Dieser Gedanke ist seit über einem Monat geparkt. Ein alter Eintrag im Eingang ist ein Signal, kein Fehler — einordnen und entscheiden.',
  'About scheduled reports': 'Informationen zu geplanten Berichten',
  'WikiKit runs these itself, in its own process. Each one writes an entry under Answers; nothing is emailed, and a briefing costs no model tokens because it is an assembly of counts and titles.':
    'WikiKit führt diese im eigenen Prozess aus. Jeder Lauf erzeugt einen Eintrag unter „Antworten“; es wird nichts per E-Mail versendet, und ein Kurzbericht verbraucht keine Modell-Tokens, weil er nur aus Zahlen und Titeln besteht.',
  'Reports that run by themselves': 'Berichte, die von selbst laufen',
  "Reading and changing the timetable is an admin's right, not a reader's.":
    'Zeitplan lesen und ändern ist ein Administrationsrecht, kein Leserecht.',
  'Save this timetable?': 'Diesen Zeitplan speichern?',
  'WikiKit runs these reports itself, from its own process.': 'WikiKit führt diese Berichte im eigenen Prozess aus.',
  'Each run writes an entry under Answers. A briefing costs nothing — it is an assembly of counts and titles — and a check report is the page above, kept.':
    'Jeder Lauf erzeugt einen Eintrag unter „Antworten“. Ein Kurzbericht kostet nichts – er besteht aus Zahlen und Titeln – und ein Prüfbericht wird oben aufbewahrt.',
  'A report switched off here stops running and keeps its record of when it last did. Nothing is emailed: a check report also raises an event, which is where a mail would be hung.':
    'Ein hier deaktivierter Bericht läuft nicht mehr und behält den Vermerk seines letzten Laufs. Es wird nichts per E-Mail versendet: Ein Prüfbericht löst zusätzlich ein Ereignis aus, an das sich ein Mailversand anschließen lässt.',
  'Save timetable': 'Zeitplan speichern',
  'Timetable saved': 'Zeitplan gespeichert',
  'The timetable has not loaded yet.': 'Der Zeitplan wurde noch nicht geladen.',
  'A time has to read HH:MM, in 24 hours.': 'Eine Uhrzeit muss im Format HH:MM (24 Stunden) angegeben werden.',
  'That is not a time zone this browser knows.': 'Diese Zeitzone ist dem Browser nicht bekannt.',
  'Morning briefing': 'Morgendlicher Kurzbericht',
  'What was approved since the last one, what is waiting, and how long the oldest has waited.':
    'Was seit dem letzten Lauf freigegeben wurde, was wartet und wie lange die älteste Änderung schon wartet.',
  'The report on this page, kept — and an event other systems can listen for.':
    'Der Bericht dieser Seite, aufbewahrt – und ein Ereignis, auf das andere Systeme hören können.',
  'Run it': 'Aktiv',
  'How often': 'Häufigkeit',
  'Every day': 'Täglich',
  'Once a week': 'Wöchentlich',
  On: 'Am',
  At: 'Um',
  'Time zone': 'Zeitzone',
  Monday: 'Montag',
  Tuesday: 'Dienstag',
  Wednesday: 'Mittwoch',
  Thursday: 'Donnerstag',
  Friday: 'Freitag',
  Saturday: 'Samstag',
  Sunday: 'Sonntag',
  'Write the guidelines': 'Leitlinien verfassen',
  'Write guidelines': 'Leitlinien schreiben',
  'Delete the guidelines': 'Leitlinien löschen',
  'Delete guidelines': 'Leitlinien entfernen',
  'No guidelines yet': 'Noch keine Leitlinien',
  'No guidelines have ever been written for this wiki.': 'Für dieses Wiki wurden noch keine Leitlinien verfasst.',
  'About guidelines Markdown': 'Informationen zum Markdown der Leitlinien',
  'Guidelines (Markdown)': 'Leitlinien (Markdown)',
  'The guidelines are not reviewed: they are configuration an admin owns, so no change proposal is created and nobody approves them.':
    'Leitlinien werden nicht geprüft: Es handelt sich um Administrationskonfiguration, es entsteht keine Änderung und niemand gibt sie frei.',
  'Until new guidelines are written, nothing steers classification and synthesis for this wiki: they fall back to their defaults. Pages already written are unaffected.':
    'Bis neue Leitlinien vorliegen, verwenden Klassifizierung und Synthese ihre Standardwerte. Bestehende Seiten bleiben unverändert.',
  'is left with no guidelines. Every revision stays readable in the history below — this deletes what is in force, not the record of it.':
    'bleibt ohne Leitlinien. Jede Fassung bleibt im Verlauf lesbar; entfernt wird nur die aktuell gültige Fassung.',
  'Every version of the guidelines written for this wiki, newest first. Writing supersedes the current revision rather than overwriting it.':
    'Alle Fassungen der Leitlinien dieses Wikis, neueste zuerst. Eine neue Fassung ersetzt die aktuelle, ohne den Verlauf zu überschreiben.',
  'Derived from current knowledge and appended to the guidelines automatically, together with an index of every page in this wiki. It is not part of the text above and cannot be edited here.':
    'Aus dem aktuellen Wissen abgeleitet und zusammen mit einem Seitenindex automatisch an die Leitlinien angehängt. Dieser Abschnitt gehört nicht zum bearbeitbaren Text.',
  'Needs admin — the guidelines are configuration, not reviewed knowledge.':
    'Erfordert admin – Leitlinien sind Konfiguration und kein geprüftes Wissen.',
  'Start from six questions': 'Mit sechs Fragen beginnen',
  'Answer what you can and leave the rest. What you write becomes an ordinary Markdown document you can edit before it is saved — an unanswered question is left out rather than left empty.':
    'Beantwortbares ausfüllen, den Rest offen lassen. Daraus entsteht ein gewöhnliches Markdown-Dokument, das sich vor dem Speichern bearbeiten lässt — eine unbeantwortete Frage entfällt, statt leer zu bleiben.',
  'Use this as a start': 'Als Ausgangspunkt verwenden',
  'Answer at least one question first.': 'Zuerst mindestens eine Frage beantworten.',
  'What belongs in this wiki': 'Was in dieses Wiki gehört',
  'What does not': 'Was nicht hineingehört',
  'Page types': 'Seitenarten',
  'What to emphasise': 'Worauf es ankommt',
  Voice: 'Sprachstil',
  'Answering questions about how we deploy, who is on call, and what to do when something breaks.':
    'Fragen dazu beantworten, wie ausgerollt wird, wer Rufbereitschaft hat und was bei einer Störung zu tun ist.',
  'Runbooks, post-mortems, architecture decisions, on-call handovers.':
    'Runbooks, Nachbetrachtungen, Architekturentscheidungen, Übergaben der Rufbereitschaft.',
  'Customer data, meeting small talk, anything that belongs in a ticket.':
    'Kundendaten, Nebensächliches aus Besprechungen und alles, was in ein Ticket gehört.',
  'One page per service, one per recurring incident, one per decision.':
    'Eine Seite je Dienst, eine je wiederkehrender Störung, eine je Entscheidung.',
  'Why a thing is done this way, and what was tried before it.':
    'Warum etwas so gemacht wird und was zuvor versucht wurde.',
  'Short sentences. Present tense. No marketing words.': 'Kurze Sätze. Präsens. Keine Werbesprache.',
  'What the linter finds in this wiki now lives on its own page, beside the two queues it cannot see and the schedule that reports on them.':
    'Die Prüfbefunde dieses Wikis stehen jetzt auf einer eigenen Seite, neben den beiden Warteschlangen und dem Zeitplan, der darüber berichtet.',
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
    const shared = phrase.match(/^(\d+) shared sources?$/)
    if (shared) {
      const amount = Number(shared[1])
      return `${leading}${amount} ${amount === 1 ? 'gemeinsame Quelle' : 'gemeinsame Quellen'}${trailing}`
    }
    const uncited = phrase.match(/^(\d+) uncited$/)
    if (uncited) return `${leading}${uncited[1]} ohne Nachweis${trailing}`
    const withheld = phrase.match(/^(\d+) claims? not counted$/)
    if (withheld)
      return `${leading}${withheld[1]} nicht gezählte ${Number(withheld[1]) === 1 ? 'Aussage' : 'Aussagen'}${trailing}`
    const quotes = phrase.match(/^(\d+) quotes cited$/)
    if (quotes) return `${leading}${quotes[1]} verwendete Zitate${trailing}`
    // The evidence badge on a claim row, and the two sentences above the claims
    // panel. Patterns rather than entries in DE_PHRASES because the number is
    // part of the phrase: „1 quote" and „7 quotes" are one sentence with a
    // count in it, not two reviewed phrases.
    const quoteCount = phrase.match(/^(\d+) quotes?$/)
    if (quoteCount) {
      const amount = Number(quoteCount[1])
      return `${leading}${amount} ${amount === 1 ? 'Zitat' : 'Zitate'}${trailing}`
    }
    const allCited = phrase.match(/^(\d+) claims?, every one quoting a source\.$/)
    if (allCited) {
      const amount = Number(allCited[1])
      return `${leading}${amount} ${amount === 1 ? 'Aussage' : 'Aussagen'}, jede mit einem Zitat aus einer Quelle.${trailing}`
    }
    const someUncited = phrase.match(/^(\d+) claims?, (\d+) of them with no quote behind it\.$/)
    if (someUncited) {
      const amount = Number(someUncited[1])
      return `${leading}${amount} ${amount === 1 ? 'Aussage' : 'Aussagen'}, davon ${someUncited[2]} ohne Zitat.${trailing}`
    }
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

/**
 * A calendar date, for places where the clock time is noise.
 *
 * Used where a machine-written title had its identifier removed and needs
 * something to tell one run from the next: "Ingest: Codex session · 15. Aug.
 * 2026" answers "which one?" the way a person would, and the minute it started
 * does not.
 */
export function formatDate(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf())
    ? '—'
    : new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium' }).format(date)
}

export function formatDateTime(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf())
    ? '—'
    : new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
