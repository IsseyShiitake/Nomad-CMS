/**
 * Typed i18n dictionaries.
 *
 * Both `en` and `fr` are typed against the `Messages` interface, so a
 * missing or misspelled key is a compile error. Components consume the
 * dictionary object directly (`m.editor.save`) — no string-key lookups.
 */

export type Locale = 'en' | 'fr';

/** A single step in the getting-started guide. */
export interface HelpStep {
  title: string;
  body: string;
}

/** A single glossary entry in the HTML basics tab. */
export interface GlossaryEntry {
  term: string;
  def: string;
}

/** Every user-visible string in the application. */
export interface Messages {
  common: {
    loading: string;
    loadingSession: string;
    cancel: string;
    close: string;
    confirm: string;
    save: string;
    delete: string;
    copy: string;
    copied: string;
    refresh: string;
    dismissError: string;
  };
  app: { name: string };
  nav: { repositories: string; settings: string; help: string; myPages: string; mainAria: string; openMenu: string; closeMenu: string };
  header: { signInGithub: string; signOut: string; languageLabel: string; themeLabel: string };
  auth: {
    signInToEditTitle: string;
    signInToEditBody: string;
    signInToBrowseTitle: string;
    signInToBrowseBody: string;
    signInToStartTitle: string;
    signInToStartBody: string;
    clientLink: string;
  };
  login: {
    title: string;
    subtitle: string;
    idLabel: string;
    passwordLabel: string;
    submit: string;
    submitting: string;
    invalid: string;
    serverUnreachable: string;
    revoked: string;
    clientTitle: string;
    developerTitle: string;
    clientTagline: string;
    developerTagline: string;
    developerIntro: string;
    platformLoginsLabel: string;
    continueWith: string;
    chooseHalfAria: string;
    backToHalves: string;
  };
  repositories: {
    title: string;
    searchPlaceholder: string;
    searchAria: string;
    filterAria: string;
    filterAll: string;
    filterPublic: string;
    filterPrivate: string;
    loadFailed: string;
    empty: string;
    noMatch: string;
    private: string;
    public: string;
    selectGuide: string;
  };
  pages: {
    title: string;
    breadcrumb: string;
    htmlFiles: string;
    searchPlaceholder: string;
    searchAria: string;
    loadFailed: string;
    contentsFailed: string;
    empty: string;
    noMatch: string;
    repoContents: string;
    parentDir: string;
    directories: string;
    files: string;
    emptyRepo: string;
    onlyPages: string;
    selectGuide: string;
  };
  editor: {
    loadingPage: string;
    loadFailed: string;
    saved: string;
    imageQueued: string;
    undo: string;
    saving: string;
    unsaved: string;
    unsavedPrompt: string;
    modifiedElsewhere: string;
    saveFailed: string;
    saveRateLimited: string;
    saveRejected: string;
    elements: string;
    noElements: string;
    livePreview: string;
    previewTitle: string;
    tagH1: string;
    tagH2: string;
    tagP: string;
    tagImg: string;
    imageSrc: string;
    uploadImage: string;
    browseFile: string;
    noFileSelected: string;
    imageTooLarge: string;
    imageTypeRejected: string;
    textPlaceholder: string;
    deleteTitle: string;
    deleteMessage: string;
    insertAbove: string;
    insertBelow: string;
    insertType: string;
    highlight: string;
    deviceDesktop: string;
    deviceTablet: string;
    deviceMobile: string;
    deviceAria: string;
    zoomIn: string;
    zoomOut: string;
    zoomFit: string;
    zoomAria: string;
    modeAria: string;
    modeBeacons: string;
    modeEditable: string;
    modeFallback: string;
    previewLegend: string;
  };
  settings: {
    title: string;
    clientsHeading: string;
    clientsIntro: string;
    createHeading: string;
    labelField: string;
    repoField: string;
    createBtn: string;
    creating: string;
    listHeading: string;
    colLabel: string;
    colId: string;
    colRepo: string;
    colCreated: string;
    colStatus: string;
    colLanguage: string;
    colActions: string;
    languageAria: string;
    statusActive: string;
    statusRevoked: string;
    resetPassword: string;
    revoke: string;
    deleteAccess: string;
    confirmRevokeTitle: string;
    confirmRevokeMsg: string;
    confirmDeleteTitle: string;
    confirmDeleteMsg: string;
    credentialsTitle: string;
    credentialsIntro: string;
    credentialsId: string;
    credentialsPassword: string;
    credentialsDone: string;
    noClients: string;
    loadFailed: string;
    createFailed: string;
    resetFailed: string;
    actionFailed: string;
    adminOnly: string;
  };
  deploy: {
    settingsHeading: string;
    settingsIntro: string;
    platformCloudflare: string;
    platformVercel: string;
    tokenLabel: string;
    accountIdLabel: string;
    connect: string;
    connecting: string;
    disconnect: string;
    connectedAs: string;
    invalidToken: string;
    connectFailed: string;
    loginWith: string;
    orPasteToken: string;
    sourceOauth: string;
    publishHeading: string;
    publishIntro: string;
    publish: string;
    publishing: string;
    stateQueued: string;
    stateBuilding: string;
    stateSuccess: string;
    stateError: string;
    stateTimeout: string;
    stateIdle: string;
    liveAt: string;
    notLinked: string;
    platformTokenRejected: string;
    deploymentFailed: string;
    autoPublished: string;
  };
  client: {
    myPagesTitle: string;
    backToPages: string;
    welcome: string;
    backingTokenInvalid: string;
    expandHint: string;
  };
  help: {
    title: string;
    tabStart: string;
    tabGlossary: string;
    openLabel: string;
    steps: HelpStep[];
    glossary: GlossaryEntry[];
  };
  notFound: { title: string; body: string };
  oauth: {
    failedTitle: string;
    cancelled: string;
    noCode: string;
    stateMismatch: string;
    failed: string;
    instanceLocked: string;
    signingIn: string;
    exchanging: string;
    backToRepositories: string;
    platformConnecting: string;
    platformFailed: string;
    platformCancelled: string;
    backToSettings: string;
  };
}

export const en: Messages = {
  common: {
    loading: 'Loading…',
    loadingSession: 'Loading session…',
    cancel: 'Cancel',
    close: 'Close',
    confirm: 'Confirm',
    save: 'Save',
    delete: 'Delete',
    copy: 'Copy',
    copied: 'Copied!',
    refresh: 'Refresh',
    dismissError: 'Dismiss error',
  },
  app: { name: 'Nomad CMS' },
  nav: {
    repositories: 'Repositories',
    settings: 'Settings',
    help: 'Help',
    myPages: 'My pages',
    mainAria: 'Main navigation',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
  },
  header: {
    signInGithub: 'Sign in with GitHub',
    signOut: 'Sign out',
    languageLabel: 'Language',
    themeLabel: 'Toggle dark mode',
  },
  auth: {
    signInToEditTitle: 'Sign in to edit',
    signInToEditBody: 'Connect your GitHub account to edit pages.',
    signInToBrowseTitle: 'Sign in to browse pages',
    signInToBrowseBody: "Connect your GitHub account to manage this repository's pages.",
    signInToStartTitle: 'Sign in to get started',
    signInToStartBody: 'Connect your GitHub account to manage your static site repositories.',
    clientLink: 'Are you a client? Sign in with your access code',
  },
  login: {
    title: 'Client sign in',
    subtitle: 'Enter the access ID and password you were given.',
    idLabel: 'Access ID',
    passwordLabel: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    invalid: 'Invalid access ID or password.',
    serverUnreachable: 'Cannot reach the server — check that the backend is running, then try again.',
    revoked: 'This access has been revoked. Contact your administrator.',
    clientTitle: 'Client',
    developerTitle: 'Developer',
    clientTagline: 'Edit your website content',
    developerTagline: 'Manage your repositories & client access',
    developerIntro: 'Sign in with your GitHub account to manage your repositories.',
    platformLoginsLabel: 'Or connect a hosting platform',
    continueWith: 'Continue with {name}',
    chooseHalfAria: 'Choose how to sign in',
    backToHalves: 'Back',
  },
  repositories: {
    title: 'Repositories',
    searchPlaceholder: 'Search repositories…',
    searchAria: 'Search repositories',
    filterAria: 'Filter repositories',
    filterAll: 'All',
    filterPublic: 'Public',
    filterPrivate: 'Private',
    loadFailed: 'Failed to load repositories. Please try again.',
    empty: 'No repositories found.',
    noMatch: 'No repositories match your search.',
    private: 'Private',
    public: 'Public',
    selectGuide: 'Select a repository to view its pages',
  },
  pages: {
    title: 'Pages — {repo}',
    breadcrumb: 'Repositories',
    htmlFiles: 'Web Pages',
    searchPlaceholder: 'Search pages…',
    searchAria: 'Search pages',
    loadFailed: 'Failed to discover HTML files.',
    contentsFailed: 'Failed to list repository contents.',
    empty: 'No HTML files found.',
    noMatch: 'No pages match your search.',
    repoContents: 'Repository contents',
    parentDir: '↑ Parent directory',
    directories: 'Directories',
    files: 'Files',
    emptyRepo: 'This repository appears to be empty.',
    onlyPages: 'Nothing besides web pages in this folder.',
    selectGuide: 'Select a page to start editing',
  },
  editor: {
    loadingPage: 'Loading page…',
    loadFailed: 'Failed to load the page for editing.',
    saved: 'Page saved.',
    imageQueued: 'Image queued for upload. Save to commit it.',
    undo: 'Undo',
    saving: 'Saving…',
    unsaved: 'Unsaved changes',
    unsavedPrompt: 'You have unsaved changes. Leave anyway?',
    modifiedElsewhere:
      'This page was modified elsewhere. Reload the page to get the latest version, then re-apply your changes.',
    saveFailed: 'Failed to save the page.',
    saveRateLimited: 'Too many requests — wait a moment and try again.',
    saveRejected: 'The server rejected the change. Check the content and try again.',
    elements: 'Elements',
    noElements: 'No editable elements found.',
    livePreview: 'Live preview',
    previewTitle: 'Live page preview',
    tagH1: 'Heading',
    tagH2: 'Subheading',
    tagP: 'Paragraph',
    tagImg: 'Image',
    imageSrc: 'Image src',
    uploadImage: 'Upload image',
    browseFile: 'Browse…',
    noFileSelected: 'No file selected',
    imageTooLarge: 'Image must be 10 MiB or smaller.',
    imageTypeRejected: 'Images must be png, jpg, jpeg, gif, webp, or avif files.',
    textPlaceholder: '{tag} text',
    deleteTitle: 'Delete element',
    deleteMessage:
      'Are you sure you want to delete this {tag} element? This change can be undone with the Undo button.',
    insertAbove: 'Insert above',
    insertBelow: 'Insert below',
    insertType: 'Insert type',
    highlight: 'Highlight editable areas',
    deviceDesktop: 'Desktop',
    deviceTablet: 'Tablet',
    deviceMobile: 'Mobile',
    deviceAria: 'Preview width',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomFit: 'Fit',
    zoomAria: 'Preview zoom',
    modeAria: 'Editable element mode',
    modeBeacons: 'Beacons',
    modeEditable: 'Editable blocks',
    modeFallback: 'No editable blocks found on this page — showing beacons (h1, h2, p, img) instead.',
    previewLegend:
      'Outlined areas are editable — click one to jump to its editor. Links are disabled in the preview.',
  },
  settings: {
    title: 'Settings',
    clientsHeading: 'Client access',
    clientsIntro:
      'Create an access ID and password for each client, linked to one repository. Clients sign in at the login page and can only edit that repository.',
    createHeading: 'Create a new access',
    labelField: 'Client name',
    repoField: 'Repository',
    createBtn: 'Create access',
    creating: 'Creating…',
    listHeading: 'Existing accesses',
    colLabel: 'Client',
    colId: 'Access ID',
    colRepo: 'Repository',
    colCreated: 'Created',
    colStatus: 'Status',
    colLanguage: 'Language',
    colActions: 'Actions',
    languageAria: 'Language for {label}',
    statusActive: 'Active',
    statusRevoked: 'Revoked',
    resetPassword: 'Reset password',
    revoke: 'Revoke',
    deleteAccess: 'Delete',
    confirmRevokeTitle: 'Revoke access',
    confirmRevokeMsg: 'The client will no longer be able to sign in.',
    confirmDeleteTitle: 'Delete access',
    confirmDeleteMsg: 'This permanently removes the access. This cannot be undone.',
    credentialsTitle: 'Access created',
    credentialsIntro: 'Save these now — the password will not be shown again.',
    credentialsId: 'Access ID',
    credentialsPassword: 'Password',
    credentialsDone: 'Done',
    noClients: 'No client accesses yet.',
    loadFailed: 'Failed to load client accesses.',
    createFailed: 'Failed to create the access.',
    resetFailed: 'Failed to reset the password.',
    actionFailed: 'The action failed. Please try again.',
    adminOnly: 'Only administrators can manage client access.',
  },
  deploy: {
    settingsHeading: 'Hosting platforms',
    settingsIntro:
      'Connect your Cloudflare Pages and Vercel accounts to publish repositories from this CMS. Tokens are stored encrypted and never leave the server.',
    platformCloudflare: 'Cloudflare Pages',
    platformVercel: 'Vercel',
    tokenLabel: 'API token',
    accountIdLabel: 'Account ID',
    connect: 'Connect',
    connecting: 'Connecting…',
    disconnect: 'Disconnect',
    connectedAs: 'Connected as {name}',
    invalidToken: 'Token rejected — reconnect required',
    connectFailed: 'Connection failed. Check the token and account ID.',
    loginWith: 'Log in with {name}',
    orPasteToken: 'or paste an API token',
    sourceOauth: 'Connected via OAuth — the token renews automatically',
    publishHeading: 'Publishing',
    publishIntro: 'Sites linked to this repository by the connected hosting platforms.',
    publish: 'Publish',
    publishing: 'Publishing…',
    stateQueued: 'Deployment queued',
    stateBuilding: 'Deployment building',
    stateSuccess: 'Live',
    stateError: 'Deployment failed',
    stateTimeout: 'Still building — check the live site in a moment',
    stateIdle: 'Idle',
    liveAt: 'Live at {url}',
    notLinked: 'No hosting platform is linked to this repository yet.',
    platformTokenRejected: 'A hosting platform rejected its token. Reconnect it in Settings.',
    deploymentFailed: 'The deployment failed on the hosting platform.',
    autoPublished: 'Saved. Publishing to the linked hosting platforms…',
  },
  client: {
    myPagesTitle: 'My pages',
    backToPages: 'Back to pages',
    welcome: 'Welcome, {label}',
    backingTokenInvalid:
      'There is a problem with this access — the GitHub connection behind it has expired or been revoked. Please ask the administrator to recreate your access.',
    expandHint: 'Your pages are loading — pick one to edit',
  },
  help: {
    title: 'Help',
    tabStart: 'Getting started',
    tabGlossary: 'HTML basics',
    openLabel: 'Open help',
    steps: [
      {
        title: 'Sign in',
        body: 'Administrators sign in with GitHub. Clients use the access ID and password given by their administrator.',
      },
      {
        title: 'Pick a page',
        body: 'Choose a repository, then open one of its HTML pages to edit.',
      },
      {
        title: 'Edit the beacons',
        body: 'Each editable block (a beacon) appears in the list. Change its text, swap an image, or add and remove blocks.',
      },
      {
        title: 'Watch the preview',
        body: 'The live preview updates as you type. Turn on highlighting to see exactly which areas are editable.',
      },
      {
        title: 'Save',
        body: 'Click Save to commit your changes to GitHub. Use Undo to revert a change before saving.',
      },
    ],
    glossary: [
      {
        term: '<h1> — Main heading',
        def: 'The biggest title on the page. Usually one per page (the page title).',
      },
      { term: '<h2> — Subheading', def: 'A section title, smaller than the main heading.' },
      { term: '<p> — Paragraph', def: 'A block of text — the body copy of your page.' },
      {
        term: '<img> — Image',
        def: 'A picture. It references an image file via its source (src).',
      },
      {
        term: 'Beacon (editable block)',
        def: 'A part of the page the CMS can edit. Headings, paragraphs and images are beacons by default; add data-editable to any element to make it editable.',
      },
      { term: 'Repository', def: 'The folder on GitHub that stores all your website files.' },
      {
        term: 'Commit',
        def: 'A saved snapshot of your changes. When you click Save, the CMS creates a commit in your repository.',
      },
      { term: 'Page', def: 'A single .html file in your repository.' },
    ],
  },
  notFound: {
    title: 'Page not found',
    body: 'The page you are looking for does not exist.',
  },
  oauth: {
    failedTitle: 'Sign in failed',
    cancelled: 'GitHub authorization was cancelled or failed.',
    noCode: 'No authorization code was received.',
    stateMismatch: 'Sign-in verification failed (state mismatch). Please try again.',
    failed: 'Failed to sign in. Please try again.',
    instanceLocked:
      'This CMS instance is locked to its operator. Sign in with the operator account.',
    signingIn: 'Signing you in…',
    exchanging: 'Exchanging your GitHub authorization code.',
    backToRepositories: 'Back to Repositories',
    platformConnecting: 'Connecting {name}…',
    platformFailed: 'The {name} login failed. Please try again from Settings.',
    platformCancelled: 'The {name} login was cancelled.',
    backToSettings: 'Back to Settings',
  },
};

export const fr: Messages = {
  common: {
    loading: 'Chargement…',
    loadingSession: 'Chargement de la session…',
    cancel: 'Annuler',
    close: 'Fermer',
    confirm: 'Confirmer',
    save: 'Enregistrer',
    delete: 'Supprimer',
    copy: 'Copier',
    copied: 'Copié !',
    refresh: 'Actualiser',
    dismissError: "Masquer l'erreur",
  },
  app: { name: 'Nomad CMS' },
  nav: {
    repositories: 'Dépôts',
    settings: 'Paramètres',
    help: 'Aide',
    myPages: 'Mes pages',
    mainAria: 'Navigation principale',
    openMenu: 'Ouvrir le menu',
    closeMenu: 'Fermer le menu',
  },
  header: {
    signInGithub: 'Se connecter avec GitHub',
    signOut: 'Se déconnecter',
    languageLabel: 'Langue',
    themeLabel: 'Basculer le mode sombre',
  },
  auth: {
    signInToEditTitle: 'Connectez-vous pour éditer',
    signInToEditBody: 'Connectez votre compte GitHub pour éditer des pages.',
    signInToBrowseTitle: 'Connectez-vous pour parcourir les pages',
    signInToBrowseBody: 'Connectez votre compte GitHub pour gérer les pages de ce dépôt.',
    signInToStartTitle: 'Connectez-vous pour commencer',
    signInToStartBody: 'Connectez votre compte GitHub pour gérer vos dépôts de site statique.',
    clientLink: "Vous êtes client ? Connectez-vous avec votre code d'accès",
  },
  login: {
    title: 'Connexion client',
    subtitle: "Saisissez l'identifiant et le mot de passe qui vous ont été fournis.",
    idLabel: "Identifiant d'accès",
    passwordLabel: 'Mot de passe',
    submit: 'Se connecter',
    submitting: 'Connexion…',
    invalid: 'Identifiant ou mot de passe invalide.',
    serverUnreachable: 'Serveur injoignable — vérifiez que le backend est démarré, puis réessayez.',
    revoked: 'Cet accès a été révoqué. Contactez votre administrateur.',
    clientTitle: 'Client',
    developerTitle: 'Développeur',
    clientTagline: 'Modifiez le contenu de votre site',
    developerTagline: 'Gérez vos dépôts et les accès clients',
    developerIntro: 'Connectez-vous avec votre compte GitHub pour gérer vos dépôts.',
    platformLoginsLabel: 'Ou connecter une plateforme d’hébergement',
    continueWith: 'Continuer avec {name}',
    chooseHalfAria: 'Choisissez votre mode de connexion',
    backToHalves: 'Retour',
  },
  repositories: {
    title: 'Dépôts',
    searchPlaceholder: 'Rechercher un dépôt…',
    searchAria: 'Rechercher un dépôt',
    filterAria: 'Filtrer les dépôts',
    filterAll: 'Tous',
    filterPublic: 'Public',
    filterPrivate: 'Privé',
    loadFailed: 'Impossible de charger les dépôts. Veuillez réessayer.',
    empty: 'Aucun dépôt trouvé.',
    noMatch: 'Aucun dépôt ne correspond à votre recherche.',
    private: 'Privé',
    public: 'Public',
    selectGuide: 'Sélectionnez un dépôt pour consulter ses pages',
  },
  pages: {
    title: 'Pages — {repo}',
    breadcrumb: 'Dépôts',
    htmlFiles: 'Pages Web',
    searchPlaceholder: 'Rechercher une page…',
    searchAria: 'Rechercher une page',
    loadFailed: 'Impossible de détecter les fichiers HTML.',
    contentsFailed: 'Impossible de lister le contenu du dépôt.',
    empty: 'Aucun fichier HTML trouvé.',
    noMatch: 'Aucune page ne correspond à votre recherche.',
    repoContents: 'Contenu du dépôt',
    parentDir: '↑ Dossier parent',
    directories: 'Dossiers',
    files: 'Fichiers',
    emptyRepo: 'Ce dépôt semble vide.',
    onlyPages: 'Rien d’autre que des pages web dans ce dossier.',
    selectGuide: 'Sélectionnez une page pour commencer la modification',
  },
  editor: {
    loadingPage: 'Chargement de la page…',
    loadFailed: 'Impossible de charger la page.',
    saved: 'Page enregistrée.',
    imageQueued: "Image en attente d'envoi. Enregistrez pour la valider.",
    undo: 'Annuler la modification',
    saving: 'Enregistrement…',
    unsaved: 'Modifications non enregistrées',
    unsavedPrompt: 'Des modifications non enregistrées seront perdues. Quitter quand même ?',
    modifiedElsewhere:
      'Cette page a été modifiée ailleurs. Rechargez la page pour obtenir la dernière version, puis réappliquez vos modifications.',
    saveFailed: "Échec de l'enregistrement de la page.",
    saveRateLimited: 'Trop de requêtes — patientez un instant puis réessayez.',
    saveRejected: 'Le serveur a refusé la modification. Vérifiez le contenu puis réessayez.',
    elements: 'Éléments',
    noElements: 'Aucun élément éditable trouvé.',
    livePreview: 'Aperçu en direct',
    previewTitle: 'Aperçu de la page en direct',
    tagH1: 'Titre',
    tagH2: 'Sous-titre',
    tagP: 'Paragraphe',
    tagImg: 'Image',
    imageSrc: "Source de l'image",
    uploadImage: 'Téléverser une image',
    browseFile: 'Parcourir…',
    noFileSelected: 'Aucun fichier sélectionné',
    imageTooLarge: 'L’image doit peser 10 Mio maximum.',
    imageTypeRejected: 'Les images doivent être des fichiers png, jpg, jpeg, gif, webp ou avif.',
    textPlaceholder: 'Texte {tag}',
    deleteTitle: "Supprimer l'élément",
    deleteMessage:
      'Voulez-vous vraiment supprimer cet élément {tag} ? Vous pouvez annuler avec le bouton Annuler.',
    insertAbove: 'Insérer au-dessus',
    insertBelow: 'Insérer en dessous',
    insertType: 'Type à insérer',
    highlight: 'Surligner les zones éditables',
    deviceDesktop: 'Bureau',
    deviceTablet: 'Tablette',
    deviceMobile: 'Mobile',
    deviceAria: "Largeur de l'aperçu",
    zoomIn: 'Zoomer',
    zoomOut: 'Dézoomer',
    zoomFit: 'Ajuster',
    zoomAria: "Zoom de l'aperçu",
    modeAria: 'Mode des éléments éditables',
    modeBeacons: 'Repères',
    modeEditable: 'Blocs éditables',
    modeFallback: 'Aucun bloc éditable sur cette page — affichage des repères (h1, h2, p, img) à la place.',
    previewLegend:
      'Les zones encadrées sont éditables — cliquez sur l’une pour accéder à son éditeur. Les liens sont désactivés dans l’aperçu.',
  },
  settings: {
    title: 'Paramètres',
    clientsHeading: 'Accès clients',
    clientsIntro:
      'Créez un identifiant et un mot de passe pour chaque client, liés à un dépôt. Les clients se connectent via la page de connexion et ne peuvent modifier que ce dépôt.',
    createHeading: 'Créer un nouvel accès',
    labelField: 'Nom du client',
    repoField: 'Dépôt',
    createBtn: "Créer l'accès",
    creating: 'Création…',
    listHeading: 'Accès existants',
    colLabel: 'Client',
    colId: 'Identifiant',
    colRepo: 'Dépôt',
    colCreated: 'Créé',
    colStatus: 'Statut',
    colLanguage: 'Langue',
    colActions: 'Actions',
    languageAria: 'Langue pour {label}',
    statusActive: 'Actif',
    statusRevoked: 'Révoqué',
    resetPassword: 'Réinitialiser le mot de passe',
    revoke: 'Révoquer',
    deleteAccess: 'Supprimer',
    confirmRevokeTitle: "Révoquer l'accès",
    confirmRevokeMsg: 'Le client ne pourra plus se connecter.',
    confirmDeleteTitle: "Supprimer l'accès",
    confirmDeleteMsg: "Cette action supprime définitivement l'accès. Elle est irréversible.",
    credentialsTitle: 'Accès créé',
    credentialsIntro: 'Enregistrez-les maintenant — le mot de passe ne sera plus affiché.',
    credentialsId: "Identifiant d'accès",
    credentialsPassword: 'Mot de passe',
    credentialsDone: 'Terminé',
    noClients: 'Aucun accès client pour le moment.',
    loadFailed: 'Impossible de charger les accès clients.',
    createFailed: "Impossible de créer l'accès.",
    resetFailed: 'Impossible de réinitialiser le mot de passe.',
    actionFailed: "Impossible d'exécuter cette action. Veuillez réessayer.",
    adminOnly: 'Seuls les administrateurs peuvent gérer les accès clients.',
  },
  deploy: {
    settingsHeading: 'Plateformes d’hébergement',
    settingsIntro:
      'Connectez vos comptes Cloudflare Pages et Vercel pour publier des dépôts depuis ce CMS. Les jetons sont stockés chiffrés et ne quittent jamais le serveur.',
    platformCloudflare: 'Cloudflare Pages',
    platformVercel: 'Vercel',
    tokenLabel: 'Jeton API',
    accountIdLabel: 'ID de compte',
    connect: 'Connecter',
    connecting: 'Connexion…',
    disconnect: 'Déconnecter',
    connectedAs: 'Connecté en tant que {name}',
    invalidToken: 'Jeton refusé — reconnexion requise',
    connectFailed: 'Échec de la connexion. Vérifiez le jeton et l’ID de compte.',
    loginWith: 'Se connecter avec {name}',
    orPasteToken: 'ou collez un jeton API',
    sourceOauth: 'Connecté via OAuth — le jeton se renouvelle automatiquement',
    publishHeading: 'Publication',
    publishIntro: 'Sites reliés à ce dépôt par les plateformes connectées.',
    publish: 'Publier',
    publishing: 'Publication…',
    stateQueued: 'Déploiement en file d’attente',
    stateBuilding: 'Déploiement en cours',
    stateSuccess: 'En ligne',
    platformTokenRejected: "Une plateforme d'hébergement a rejeté son jeton. Reconnectez-la dans les paramètres.",
    deploymentFailed: 'Le déploiement a échoué sur la plateforme d’hébergement.',
    autoPublished: 'Enregistré. Publication vers les plateformes reliées…',
    stateError: 'Échec du déploiement',
    stateTimeout: 'Toujours en construction — vérifiez le site dans un instant',
    stateIdle: 'Inactif',
    liveAt: 'En ligne sur {url}',
    notLinked: 'Aucune plateforme d’hébergement n’est encore reliée à ce dépôt.',
  },
  client: {
    myPagesTitle: 'Mes pages',
    backToPages: 'Retour aux pages',
    welcome: 'Bienvenue, {label}',
    backingTokenInvalid:
      "Il y a un problème avec cet accès — la connexion GitHub associée a expiré ou a été révoquée. Demandez à l'administrateur de recréer votre accès.",
    expandHint: 'Vos pages se chargent — choisissez-en une à modifier',
  },
  help: {
    title: 'Aide',
    tabStart: 'Premiers pas',
    tabGlossary: 'Bases du HTML',
    openLabel: "Ouvrir l'aide",
    steps: [
      {
        title: 'Se connecter',
        body: "Les administrateurs se connectent avec GitHub. Les clients utilisent l'identifiant et le mot de passe fournis par leur administrateur.",
      },
      {
        title: 'Choisir une page',
        body: 'Choisissez un dépôt, puis ouvrez une de ses pages HTML pour la modifier.',
      },
      {
        title: 'Modifier les repères',
        body: 'Chaque bloc éditable (un repère) apparaît dans la liste. Changez son texte, remplacez une image, ou ajoutez et supprimez des blocs.',
      },
      {
        title: "Suivre l'aperçu",
        body: "L'aperçu en direct se met à jour pendant la saisie. Activez le surlignage pour voir les zones éditables.",
      },
      {
        title: 'Enregistrer',
        body: "Cliquez sur Enregistrer pour valider vos modifications sur GitHub. Utilisez Annuler pour revenir en arrière avant d'enregistrer.",
      },
    ],
    glossary: [
      {
        term: '<h1> — Titre principal',
        def: 'Le plus grand titre de la page. En général un seul par page (le titre de la page).',
      },
      { term: '<h2> — Sous-titre', def: 'Un titre de section, plus petit que le titre principal.' },
      { term: '<p> — Paragraphe', def: 'Un bloc de texte — le contenu de votre page.' },
      {
        term: '<img> — Image',
        def: 'Une image. Elle référence un fichier image via sa source (src).',
      },
      {
        term: 'Repère (bloc éditable)',
        def: 'Une partie de la page que le CMS peut modifier. Les titres, paragraphes et images sont des repères par défaut ; ajoutez data-editable à un élément pour le rendre éditable.',
      },
      { term: 'Dépôt', def: 'Le dossier sur GitHub qui contient tous les fichiers de votre site.' },
      {
        term: 'Commit',
        def: 'Un instantané de vos modifications. Quand vous cliquez sur Enregistrer, le CMS crée un commit dans votre dépôt.',
      },
      { term: 'Page', def: 'Un fichier .html de votre dépôt.' },
    ],
  },
  notFound: {
    title: 'Page introuvable',
    body: "La page que vous recherchez n'existe pas.",
  },
  oauth: {
    failedTitle: 'Échec de la connexion',
    cancelled: "L'autorisation GitHub a été annulée ou a échoué.",
    noCode: "Aucun code d'autorisation n'a été reçu.",
    stateMismatch: 'La vérification de la connexion a échoué (state différent). Veuillez réessayer.',
    failed: 'Impossible de se connecter. Veuillez réessayer.',
    instanceLocked:
      'Cette instance du CMS est réservée à son opérateur. Connectez-vous avec le compte opérateur.',
    signingIn: 'Connexion en cours…',
    exchanging: "Échange de votre code d'autorisation GitHub.",
    backToRepositories: 'Retour aux dépôts',
    platformConnecting: 'Connexion à {name}…',
    platformFailed: 'La connexion à {name} a échoué. Veuillez réessayer depuis les réglages.',
    platformCancelled: 'La connexion à {name} a été annulée.',
    backToSettings: 'Retour aux réglages',
  },
};
