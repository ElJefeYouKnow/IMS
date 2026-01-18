module.exports = function canUseBMS(caps) {
  return !!caps?.bms_enabled;
};
