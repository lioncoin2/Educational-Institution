/// Web device-media capability: always supported — every plugin behind the
/// seams ships a web implementation.
///
/// The [operatingSystem] argument exists only to share one signature with the
/// native implementation (conditional import); the web ignores it.
bool deviceMediaSupported({String? operatingSystem}) => true;
