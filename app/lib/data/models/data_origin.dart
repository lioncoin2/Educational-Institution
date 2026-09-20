/// Where a piece of content came from.
///
/// This is the backbone of the prototype's honesty rule: anything that is not
/// [DataOrigin.profile] is placeholder content invented to make the UI
/// explorable, and the UI must say so.
enum DataOrigin {
  /// Taken from `docs/institution-profile.pdf`. Real institution information.
  profile,

  /// Invented for the prototype. Must be visibly flagged in the UI.
  mock;

  bool get isMock => this == DataOrigin.mock;
}

/// Anything that can be shown to the user carries its provenance.
abstract interface class Sourced {
  DataOrigin get origin;
}
