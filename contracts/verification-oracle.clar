;; VerificationOracle.clar
;; 
;; This contract serves as an oracle for verifying off-chain data related to urban green initiatives,
;; such as emission reductions from rooftop solar installations. It ensures data integrity by allowing
;; only trusted sources to submit verifications, validates against initiative requirements, and stores
;; immutable records. It integrates with other contracts like InitiativeRegistry and RewardDistributor.

;; Constants
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-DATA u101)
(define-constant ERR-INITIATIVE-NOT-FOUND u102)
(define-constant ERR-ORACLE-ALREADY-EXISTS u103)
(define-constant ERR-ORACLE-NOT-FOUND u104)
(define-constant ERR-EXPIRED-DATA u105)
(define-constant ERR-INVALID-INITIATIVE-ID u106)
(define-constant ERR-INVALID-EMISSION-REDUCTION u107)
(define-constant ERR-INVALID-METADATA u108)
(define-constant ERR-CONTRACT-PAUSED u109)
(define-constant ERR-INVALID-TIMESTAMP u110)
(define-constant ERR-DUPLICATE-SUBMISSION u111)
(define-constant ERR-INSUFFICIENT-ORACLE-AGREEMENT u112)
(define-constant MAX-METADATA-LEN u500)
(define-constant DATA-EXPIRY-BLOCKS u1440) ;; ~10 days assuming 10-min blocks
(define-constant MIN-ORACLE-AGREEMENT u2) ;; Minimum oracles needed for consensus

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var oracle-admin principal tx-sender)
(define-data-var contract-paused bool false)
(define-data-var oracle-counter uint u0)

;; Data Maps
(define-map trusted-oracles
  { oracle-id: uint }
  {
    oracle-principal: principal,
    name: (string-utf8 50),
    description: (string-utf8 200),
    active: bool,
    added-at: uint,
    reputation: uint ;; Score based on successful verifications
  }
)

(define-map verified-data
  { user: principal, initiative-id: uint, submission-id: uint }
  {
    emission-reduction: uint,
    metadata: (string-utf8 500),
    timestamp: uint,
    verifying-oracles: (list 10 uint), ;; List of oracle-ids that verified
    consensus-reached: bool,
    expiry: uint
  }
)

(define-map submission-counter
  { user: principal, initiative-id: uint }
  uint
)

;; Private Functions
(define-private (is-oracle-authorized (oracle principal))
  (fold check-oracle (map-get? trusted-oracles-keys) false)
)

(define-private (check-oracle (oracle-id uint) (authorized bool))
  (or authorized
      (let ((oracle (map-get? trusted-oracles {oracle-id: oracle-id})))
        (and (is-some oracle)
             (is-eq (get oracle-principal (unwrap-panic oracle)) tx-sender)
             (get active (unwrap-panic oracle)))))
)

(define-private (validate-emission-reduction (initiative-id uint) (reduction uint))
  (let ((initiative (contract-call? .InitiativeRegistry get-initiative initiative-id)))
    (asserts! (is-ok initiative) (err ERR-INITIATIVE-NOT-FOUND))
    (let ((details (unwrap-panic initiative)))
      (asserts! (>= reduction (get min-reduction details)) (err ERR-INVALID-EMISSION-REDUCTION))
      (asserts! (<= reduction (get max-reduction details)) (err ERR-INVALID-EMISSION-REDUCTION))
      (ok true))))

(define-private (increment-submission-counter (user principal) (initiative-id uint))
  (let ((current (default-to u0 (map-get? submission-counter {user: user, initiative-id: initiative-id}))))
    (map-set submission-counter {user: user, initiative-id: initiative-id} (+ current u1))
    (+ current u1)))

(define-private (check-consensus (submission-id uint) (user principal) (initiative-id uint))
  (let ((data (map-get? verified-data {user: user, initiative-id: initiative-id, submission-id: submission-id})))
    (if (is-some data)
        (let ((unwrapped (unwrap-panic data)))
          (if (>= (len (get verifying-oracles unwrapped)) MIN-ORACLE-AGREEMENT)
              (begin
                (map-set verified-data
                  {user: user, initiative-id: initiative-id, submission-id: submission-id}
                  (merge unwrapped {consensus-reached: true}))
                true)
              false))
        false)))

;; Public Functions

;; Submit verification data from a trusted oracle
(define-public (submit-verification 
  (user principal) 
  (initiative-id uint) 
  (emission-reduction uint) 
  (metadata (string-utf8 500))
  (oracle-id uint))
  (begin
    (asserts! (not (var-get contract-paused)) (err ERR-CONTRACT-PAUSED))
    (asserts! (is-some (map-get? trusted-oracles {oracle-id: oracle-id})) (err ERR-ORACLE-NOT-FOUND))
    (let ((oracle (unwrap-panic (map-get? trusted-oracles {oracle-id: oracle-id}))))
      (asserts! (get active oracle) (err ERR-NOT-AUTHORIZED))
      (asserts! (is-eq tx-sender (get oracle-principal oracle)) (err ERR-NOT-AUTHORIZED)))
    (try! (validate-emission-reduction initiative-id emission-reduction))
    (asserts! (<= (len metadata) MAX-METADATA-LEN) (err ERR-INVALID-METADATA))
    (let ((submission-id (increment-submission-counter user initiative-id)))
      (asserts! (is-none (map-get? verified-data {user: user, initiative-id: initiative-id, submission-id: submission-id})) (err ERR-DUPLICATE-SUBMISSION))
      (map-set verified-data
        {user: user, initiative-id: initiative-id, submission-id: submission-id}
        {
          emission-reduction: emission-reduction,
          metadata: metadata,
          timestamp: block-height,
          verifying-oracles: (list oracle-id),
          consensus-reached: false,
          expiry: (+ block-height DATA-EXPIRY-BLOCKS)
        })
      (if (check-consensus submission-id user initiative-id)
          (ok true)
          (ok false))))) ;; Returns true if consensus reached immediately (single oracle case if min=1)

;; Add a new trusted oracle (admin only)
(define-public (add-trusted-oracle 
  (oracle-principal principal)
  (name (string-utf8 50))
  (description (string-utf8 200)))
  (begin
    (asserts! (is-eq tx-sender (var-get oracle-admin)) (err ERR-NOT-AUTHORIZED))
    (let ((new-id (+ (var-get oracle-counter) u1)))
      (asserts! (is-none (fold find-oracle trusted-oracles-keys none)) (err ERR-ORACLE-ALREADY-EXISTS))
      (map-set trusted-oracles
        {oracle-id: new-id}
        {
          oracle-principal: oracle-principal,
          name: name,
          description: description,
          active: true,
          added-at: block-height,
          reputation: u100 ;; Starting reputation
        })
      (var-set oracle-counter new-id)
      (ok new-id))))

(define-private (find-oracle (id uint) (found (optional uint)))
  (let ((oracle (map-get? trusted-oracles {oracle-id: id})))
    (if (and (is-some oracle) (is-eq (get oracle-principal (unwrap-panic oracle)) oracle-principal))
        (some id)
        found)))

;; Remove or deactivate an oracle (admin only)
(define-public (remove-trusted-oracle (oracle-id uint))
  (begin
    (asserts! (is-eq tx-sender (var-get oracle-admin)) (err ERR-NOT-AUTHORIZED))
    (let ((oracle (map-get? trusted-oracles {oracle-id: oracle-id})))
      (asserts! (is-some oracle) (err ERR-ORACLE-NOT-FOUND))
      (map-set trusted-oracles
        {oracle-id: oracle-id}
        (merge (unwrap-panic oracle) {active: false}))
      (ok true))))

;; Update oracle reputation (called by governance or admin)
(define-public (update-oracle-reputation (oracle-id uint) (new-reputation uint))
  (begin
    (asserts! (is-eq tx-sender (var-get oracle-admin)) (err ERR-NOT-AUTHORIZED))
    (let ((oracle (map-get? trusted-oracles {oracle-id: oracle-id})))
      (asserts! (is-some oracle) (err ERR-ORACLE-NOT-FOUND))
      (map-set trusted-oracles
        {oracle-id: oracle-id}
        (merge (unwrap-panic oracle) {reputation: new-reputation}))
      (ok true))))

;; Pause the contract (admin only)
(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-NOT-AUTHORIZED))
    (ok (var-set contract-paused true))))

;; Unpause the contract (admin only)
(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-NOT-AUTHORIZED))
    (ok (var-set contract-paused false))))

;; Transfer admin role
(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get oracle-admin)) (err ERR-NOT-AUTHORIZED))
    (ok (var-set oracle-admin new-admin))))

;; Read-Only Functions

;; Verify emission data for a specific submission
(define-read-only (verify-emission-data (user principal) (initiative-id uint) (submission-id uint))
  (let ((data (map-get? verified-data {user: user, initiative-id: initiative-id, submission-id: submission-id})))
    (if (is-some data)
        (let ((unwrapped (unwrap-panic data)))
          (if (and (get consensus-reached unwrapped)
                   (< block-height (get expiry unwrapped)))
              (ok (get emission-reduction unwrapped))
              (err ERR-INVALID-DATA)))
        (err ERR-INVALID-DATA))))

;; Get verified data details
(define-read-only (get-verified-data (user principal) (initiative-id uint) (submission-id uint))
  (map-get? verified-data {user: user, initiative-id: initiative-id, submission-id: submission-id}))

;; Get oracle details
(define-read-only (get-oracle-details (oracle-id uint))
  (map-get? trusted-oracles {oracle-id: oracle-id}))

;; Get submission count for a user-initiative pair
(define-read-only (get-submission-count (user principal) (initiative-id uint))
  (default-to u0 (map-get? submission-counter {user: user, initiative-id: initiative-id})))

;; Check if contract is paused
(define-read-only (is-paused)
  (var-get contract-paused))

;; Additional function: Add verification from another oracle to an existing submission (for multi-oracle consensus)
(define-public (add-verification-to-submission
  (user principal)
  (initiative-id uint)
  (submission-id uint)
  (oracle-id uint)
  (agreed-reduction uint)
  (metadata (string-utf8 500)))
  (begin
    (asserts! (not (var-get contract-paused)) (err ERR-CONTRACT-PAUSED))
    (let ((oracle (map-get? trusted-oracles {oracle-id: oracle-id})))
      (asserts! (is-some oracle) (err ERR-ORACLE-NOT-FOUND))
      (asserts! (get active (unwrap-panic oracle)) (err ERR-NOT-AUTHORIZED))
      (asserts! (is-eq tx-sender (get oracle-principal (unwrap-panic oracle))) (err ERR-NOT-AUTHORIZED)))
    (let ((data (map-get? verified-data {user: user, initiative-id: initiative-id, submission-id: submission-id})))
      (asserts! (is-some data) (err ERR-INVALID-DATA))
      (let ((unwrapped (unwrap-panic data)))
        (asserts! (is-eq agreed-reduction (get emission-reduction unwrapped)) (err ERR-INVALID-DATA)) ;; Must agree on value
        (asserts! (not (is-some (index-of (get verifying-oracles unwrapped) oracle-id))) (err ERR-DUPLICATE-SUBMISSION))
        (map-set verified-data
          {user: user, initiative-id: initiative-id, submission-id: submission-id}
          (merge unwrapped {verifying-oracles: (append (get verifying-oracles unwrapped) oracle-id)}))
        (if (check-consensus submission-id user initiative-id)
            (ok true)
            (ok false))))))